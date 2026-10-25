/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Link } from "@components/Link";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { sleep } from "@utils/misc";
import definePlugin, { PluginNative } from "@utils/types";
import { saveFile } from "@utils/web";
import { Message, MessageAttachment } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import { CloudUploader, Constants, DraftType, FluxDispatcher, RestAPI, showToast, UserStore, useState } from "@webpack/common";

const logger = new Logger("NoFileLimit");
const Native = VencordNative?.pluginHelpers?.NoFileLimit as PluginNative<typeof import("./native")> | undefined;
const FileLimits = findByPropsLazy("getUserMaxFileSize");

const MANIFEST_RE = /^nfl_([0-9a-f]{8})\.json$/;
const PART_RE = /^nfl_([0-9a-f]{8})_(\d+)\.part$/;
const FILES_PER_MESSAGE = 10;
const SEARCH_PAGES = 10;

interface Manifest {
    id: string;
    name: string;
    size: number;
    type: string;
    hashes: string[];
}

interface RawMessage {
    id: string;
    author: { id: string; };
    attachments: MessageAttachment[];
}

async function sha256(data: Blob | Uint8Array<ArrayBuffer>) {
    const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
    return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

async function download(url: string): Promise<Uint8Array<ArrayBuffer>> {
    if (Native) {
        const res = await Native.fetchAttachment(url);
        if (!res.success) throw new Error(res.error);
        return new Uint8Array(res.data);
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed with status ${res.status}.`);
    return new Uint8Array(await res.arrayBuffer());
}

function formatSize(bytes: number) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function sendSplit(channelId: string, file: File, limit: number) {
    const partSize = Math.floor(limit * 0.95);
    const count = Math.ceil(file.size / partSize);
    const pad = Math.max(3, String(count).length);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("");

    showToast({ text: `Splitting ${file.name} into ${count} parts.` });

    const files: File[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < count; i++) {
        const blob = file.slice(i * partSize, (i + 1) * partSize);
        hashes.push(await sha256(blob));
        files.push(new File([blob], `nfl_${id}_${String(i + 1).padStart(pad, "0")}.part`, { type: "application/octet-stream" }));
    }

    const manifest: Manifest = { id, name: file.name, size: file.size, type: file.type, hashes };
    files.push(new File([JSON.stringify(manifest)], `nfl_${id}.json`, { type: "application/json" }));

    const batches = Math.ceil(files.length / FILES_PER_MESSAGE);
    for (let i = 0; i < batches; i++) {
        const isLast = i === batches - 1;
        const uploads = files
            .slice(i * FILES_PER_MESSAGE, (i + 1) * FILES_PER_MESSAGE)
            .map(f => new CloudUploader({ file: f, platform: CloudUploadPlatform.WEB }, channelId));

        await sendMessage(channelId, {
            content: isLast ? `**${file.name}** (${formatSize(file.size)}) split into ${count} parts with No File Limit.` : ""
        }, true, { attachmentsToUpload: uploads });

        showToast({ text: `Sent ${i + 1} of ${batches} messages.` });
        if (!isLast) await sleep(1500);
    }

    showToast({ text: `${file.name} sent.`, variant: "success" });
}

function collectParts(id: string, attachments: MessageAttachment[], urls: Map<number, string>) {
    for (const { filename, url } of attachments) {
        const match = PART_RE.exec(filename);
        if (match?.[1] === id) urls.set(Number(match[2]) - 1, url);
    }
}

async function fetchMessages(channelId: string, query: { before?: string; after?: string; }): Promise<RawMessage[]> {
    const res = await RestAPI.get({ url: Constants.Endpoints.MESSAGES(channelId), query: { ...query, limit: 100 } });
    return res.body;
}

async function mergeFile(message: Message, manifestUrl: string, setStatus: (status: string) => void) {
    setStatus("Reading manifest...");
    const manifest: Manifest = JSON.parse(new TextDecoder().decode(await download(manifestUrl)));
    const total = manifest.hashes.length;

    const urls = new Map<number, string>();
    const authorId = message.author.id;
    collectParts(manifest.id, message.attachments, urls);

    const scan = (messages: RawMessage[]) => messages
        .filter(m => m.author.id === authorId)
        .forEach(m => collectParts(manifest.id, m.attachments, urls));

    if (urls.size < total) scan(await fetchMessages(message.channel_id, { after: message.id }));

    let before = message.id;
    for (let page = 0; page < SEARCH_PAGES && urls.size < total; page++) {
        setStatus(`Finding parts (${urls.size}/${total})...`);
        const messages = await fetchMessages(message.channel_id, { before });
        if (!messages.length) break;
        scan(messages);
        before = messages[messages.length - 1].id;
    }

    if (urls.size < total) throw new Error(`Only found ${urls.size} of ${total} parts.`);

    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let i = 0; i < total; i++) {
        setStatus(`Downloading part ${i + 1}/${total}...`);
        const url = urls.get(i);
        if (!url) throw new Error(`Part ${i + 1} is missing.`);

        const data = await download(url);
        if (await sha256(data) !== manifest.hashes[i]) throw new Error(`Part ${i + 1} is corrupted.`);
        parts.push(data);
    }

    const file = new File(parts, manifest.name, { type: manifest.type });
    if (file.size !== manifest.size) throw new Error("Merged file size does not match.");
    saveFile(file);
}

const MergeButton = ErrorBoundary.wrap(({ message, manifest }: { message: Message; manifest: MessageAttachment; }) => {
    const [status, setStatus] = useState<string | null>(null);

    const onClick = () => mergeFile(message, manifest.url, setStatus)
        .then(() => showToast({ text: "File merged.", variant: "success" }))
        .catch((e: unknown) => {
            logger.error("Failed to merge file", e);
            showToast({ text: e instanceof Error ? e.message : "Failed to merge file.", variant: "critical" });
        })
        .finally(() => setStatus(null));

    return (
        <Button className={Margins.top8} size="small" disabled={status !== null} onClick={onClick}>
            {status ?? "Download merged file"}
        </Button>
    );
}, { noop: true });

interface AddFilesEvent {
    type: string;
    channelId: string;
    draftType: number;
    files?: unknown[];
    uploads?: unknown[];
    items?: unknown[];
}

function getFile(entry: unknown): File | null {
    if (entry instanceof File) return entry;
    if (!entry || typeof entry !== "object") return null;
    if ("file" in entry && entry.file instanceof File) return entry.file;
    if ("item" in entry) return getFile(entry.item);
    return null;
}

function interceptAddFiles(event: AddFilesEvent) {
    if (event.type !== "UPLOAD_ATTACHMENT_ADD_FILES" || event.draftType !== DraftType.ChannelMessage) return;

    const limit: number = FileLimits.getUserMaxFileSize(UserStore.getCurrentUser());
    const oversized = new Set<File>();
    const keep = (entries?: unknown[]) => entries?.filter(entry => {
        const file = getFile(entry);
        if (!file || file.size <= limit) return true;
        oversized.add(file);
        return false;
    });

    event.files = keep(event.files);
    event.uploads = keep(event.uploads);
    event.items = keep(event.items);

    for (const file of oversized) {
        sendSplit(event.channelId, file, limit).catch((e: unknown) => {
            logger.error("Failed to send split file", e);
            showToast({ text: `Failed to send ${file.name}.`, variant: "critical" });
        });
    }
}

export default definePlugin({
    name: "NoFileLimit",
    description: "Automatically splits files over the upload limit into parts and merges them back into one file.",
    authors: [{ name: "GreenyBeany", id: 490171777171980308n }],

    settingsAboutComponent: () => (
        <Link href="https://github.com/greenythebeany/NoFileLimit">Source code on GitHub</Link>
    ),

    patches: [
        {
            find: "#{intl::UPLOAD_AREA_TOO_LARGE_HELP_PREMIUM_TIER_1}",
            replacement: {
                match: /(?<=#{intl::UPLOAD_AREA_TOO_LARGE_HELP}.{0,250})Array\.from\(\i\)(?=\.some)/,
                replace: "[]"
            }
        }
    ],

    start() {
        FluxDispatcher.addInterceptor(interceptAddFiles);
    },

    stop() {
        const index = FluxDispatcher._interceptors.indexOf(interceptAddFiles);
        if (index > -1) FluxDispatcher._interceptors.splice(index, 1);
    },

    renderMessageAccessory(props: Record<string, any>) {
        const { message } = props as { message: Message; };
        const manifest = message.attachments.find(a => MANIFEST_RE.test(a.filename));
        if (!manifest) return null;
        return <MergeButton message={message} manifest={manifest} />;
    }
});
