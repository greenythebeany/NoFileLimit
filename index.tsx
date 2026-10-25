/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Link } from "@components/Link";
import { classNameFactory } from "@utils/css";
import { sendMessage } from "@utils/discord";
import { proxyLazy } from "@utils/lazy";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { saveFile } from "@utils/web";
import { Message, MessageAttachment } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import { CloudUploader, Constants, createRoot, DraftType, FluxDispatcher, RestAPI, showToast, useEffect, useMemo, UserStore, useState, zustandCreate } from "@webpack/common";
import type { Root } from "react-dom/client";

const logger = new Logger("NoFileLimit");
const Native = VencordNative?.pluginHelpers?.NoFileLimit as PluginNative<typeof import("./native")> | undefined;
const FileLimits = findByPropsLazy("getUserMaxFileSize");

const MANIFEST_RE = /^nfl_([0-9a-f]{8})\.json$/;
const PART_RE = /^nfl_([0-9a-f]{8})_(\d+)\.part$/;
const FILES_PER_MESSAGE = 10;
const SEARCH_PAGES = 10;
const SHOW_PROGRESS_KEYS: "showProgress"[] = ["showProgress"];

let overlayRoot: Root | null = null;
const partCache = new Map<string, Map<number, string>>();
const manifestCache = new Map<string, string>();

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

interface Progress {
    name: string;
    label: string;
    done: number;
    total: number;
}

const settings = definePluginSettings({
    splitSizeMB: {
        type: OptionType.NUMBER,
        description: "Size of each part in MB. Set to 0 to pick the largest size your upload limit allows.",
        default: 0,
        isValid: (value: number) => value >= 0 || "Part size can't be negative."
    },
    showProgress: {
        type: OptionType.BOOLEAN,
        description: "Show upload and download progress in the top right corner.",
        default: true
    },
    autoLoadMB: {
        type: OptionType.NUMBER,
        description: "Automatically load videos, images and audio up to this size in MB so they play in chat. Set to 0 to always click Play first.",
        default: 100,
        isValid: (value: number) => value >= 0 || "Size can't be negative."
    }
});

const useProgressStore: {
    <T>(selector: (state: { transfers: Record<string, Progress>; }) => T): T;
    getState(): { transfers: Record<string, Progress>; };
    setState(state: { transfers: Record<string, Progress>; }): void;
} = proxyLazy(() => zustandCreate(() => ({ transfers: {} })));

const cl = classNameFactory("vc-nfl-");

const ProgressOverlay = ErrorBoundary.wrap(() => {
    const transfers = useProgressStore(s => s.transfers);
    const { showProgress } = settings.use(SHOW_PROGRESS_KEYS);
    const entries = Object.entries(transfers);
    if (!showProgress || !entries.length) return null;

    return (
        <div className={cl("overlay")}>
            {entries.map(([key, { name, label, done, total }]) => (
                <div key={key} className={cl("card")}>
                    <div className={cl("name")}>{name}</div>
                    <div className={cl("label")}>{label}</div>
                    <div className={cl("bar")}>
                        <div className={cl("fill")} style={{ width: `${Math.round(done / total * 100)}%` }} />
                    </div>
                </div>
            ))}
        </div>
    );
}, { noop: true });

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

function setProgress(key: string, progress: Progress | null) {
    const { transfers } = useProgressStore.getState();
    if (progress) {
        useProgressStore.setState({ transfers: { ...transfers, [key]: progress } });
        return;
    }
    const { [key]: _, ...rest } = transfers;
    useProgressStore.setState({ transfers: rest });
}

function getPartSize(limit: number) {
    const { splitSizeMB } = settings.store;
    return splitSizeMB > 0 ? Math.min(Math.floor(splitSizeMB * 1024 * 1024), limit) : Math.floor(limit * 0.95);
}

async function sendSplit(channelId: string, file: File, limit: number) {
    const partSize = getPartSize(limit);
    const count = Math.ceil(file.size / partSize);
    const pad = Math.max(3, String(count).length);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("");
    const key = `send-${id}`;

    if (!settings.store.showProgress) showToast({ text: `Splitting ${file.name} into ${count} parts.` });

    try {
        const files: File[] = [];
        const hashes: string[] = [];
        for (let i = 0; i < count; i++) {
            setProgress(key, { name: file.name, label: `Preparing part ${i + 1}/${count}`, done: i, total: count });
            const blob = file.slice(i * partSize, (i + 1) * partSize);
            hashes.push(await sha256(blob));
            files.push(new File([blob], `nfl_${id}_${String(i + 1).padStart(pad, "0")}.part`, { type: "application/octet-stream" }));
        }

        const manifest: Manifest = { id, name: file.name, size: file.size, type: file.type, hashes };
        files.push(new File([JSON.stringify(manifest)], `nfl_${id}.json`, { type: "application/json" }));

        const batches = Math.ceil(files.length / FILES_PER_MESSAGE);
        let sentBytes = 0;
        for (let i = 0; i < batches; i++) {
            const isLast = i === batches - 1;
            const batch = files.slice(i * FILES_PER_MESSAGE, (i + 1) * FILES_PER_MESSAGE);
            const uploads = batch.map(f => new CloudUploader({ file: f, platform: CloudUploadPlatform.WEB }, channelId));
            const label = `Uploading message ${i + 1}/${batches}`;

            setProgress(key, { name: file.name, label, done: sentBytes, total: file.size });
            for (const upload of uploads) {
                upload.on("progress", () => setProgress(key, {
                    name: file.name,
                    label,
                    done: Math.min(file.size, sentBytes + uploads.reduce((sum, u) => sum + (u.loaded ?? 0), 0)),
                    total: file.size
                }));
            }

            await sendMessage(channelId, {
                content: isLast ? `**${file.name}** (${formatSize(file.size)}) split into ${count} parts with No File Limit.` : ""
            }, true, { attachmentsToUpload: uploads });

            sentBytes += batch.reduce((sum, f) => sum + f.size, 0);
            if (!settings.store.showProgress) showToast({ text: `Sent ${i + 1} of ${batches} messages.` });
            if (!isLast) await sleep(1500);
        }

        showToast({ text: `${file.name} sent.`, variant: "success" });
    } finally {
        setProgress(key, null);
    }
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

async function assembleFile(message: Message, manifest: Manifest, setStatus: (status: string) => void) {
    const key = `merge-${message.id}`;
    try {
        return await downloadParts(message, manifest, key, setStatus);
    } finally {
        setProgress(key, null);
    }
}

async function downloadParts(message: Message, manifest: Manifest, key: string, setStatus: (status: string) => void) {
    const total = manifest.hashes.length;
    const urls = new Map(partCache.get(manifest.id));
    const authorId = message.author.id;

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
        setProgress(key, { name: manifest.name, label: `Downloading part ${i + 1}/${total}`, done: i, total });
        const url = urls.get(i);
        if (!url) throw new Error(`Part ${i + 1} is missing.`);

        const data = await download(url);
        if (await sha256(data) !== manifest.hashes[i]) throw new Error(`Part ${i + 1} is corrupted.`);
        parts.push(data);
    }

    const file = new File(parts, manifest.name, { type: manifest.type });
    if (file.size !== manifest.size) throw new Error("Merged file size does not match.");
    return file;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);

function getMediaKind(type: string) {
    const kind = type.split("/")[0];
    if (kind === "image") return IMAGE_TYPES.has(type) ? kind : null;
    if (kind !== "video" && kind !== "audio") return null;
    return document.createElement(kind).canPlayType(type) ? kind : null;
}

const SplitAttachment = ErrorBoundary.wrap(({ message, manifestUrl }: { message: Message; manifestUrl: string; }) => {
    const [manifest, setManifest] = useState<Manifest | null>(null);
    const [file, setFile] = useState<File | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const url = useMemo(() => file && URL.createObjectURL(file), [file]);

    useEffect(() => () => {
        if (url) URL.revokeObjectURL(url);
    }, [url]);

    const load = (m: Manifest) => {
        setStatus("Loading...");
        return assembleFile(message, m, setStatus)
            .then(f => {
                setFile(f);
                return f;
            })
            .catch((e: unknown) => {
                logger.error("Failed to merge file", e);
                showToast({ text: e instanceof Error ? e.message : "Failed to merge file.", variant: "critical" });
                return null;
            })
            .finally(() => setStatus(null));
    };

    useEffect(() => {
        download(manifestUrl)
            .then(data => {
                const m: Manifest = JSON.parse(new TextDecoder().decode(data));
                setManifest(m);
                const { autoLoadMB } = settings.store;
                if (getMediaKind(m.type) && m.size <= autoLoadMB * 1024 * 1024) load(m);
            })
            .catch((e: unknown) => logger.error("Failed to read manifest", e));
    }, [manifestUrl]);

    if (!manifest) return null;

    const kind = getMediaKind(manifest.type);
    const save = async () => {
        const f = file ?? await load(manifest);
        if (f) saveFile(f);
    };

    return (
        <div className={cl("attachment")}>
            {url && kind === "video" && <video className={cl("media")} src={url} controls />}
            {url && kind === "image" && <img className={cl("media")} src={url} alt={manifest.name} />}
            {url && kind === "audio" && <audio className={cl("audio")} src={url} controls />}
            <div className={cl("info")}>
                <div className={cl("meta")}>
                    <div className={cl("name")}>{manifest.name}</div>
                    <div className={cl("label")}>{status ?? formatSize(manifest.size)}</div>
                </div>
                {kind && !url && (
                    <Button size="small" disabled={status !== null} onClick={() => load(manifest)}>Play</Button>
                )}
                <Button size="small" variant="secondary" disabled={status !== null} onClick={save}>Download</Button>
            </div>
        </div>
    );
}, { noop: true });

interface RawMessageEvent {
    type: string;
    message?: { id: string; content?: string; attachments?: MessageAttachment[]; };
    messages?: { id: string; content?: string; attachments?: MessageAttachment[]; }[];
}

const SPLIT_CONTENT_RE = /split into \d+ parts with No File Limit\.$/;

function stripParts(message: { id: string; content?: string; attachments?: MessageAttachment[]; }) {
    if (!message.attachments?.length) return;

    let hasManifest = false;
    message.attachments = message.attachments.filter(({ filename, url }) => {
        const part = PART_RE.exec(filename);
        if (part) {
            const parts = partCache.get(part[1]) ?? new Map<number, string>();
            parts.set(Number(part[2]) - 1, url);
            partCache.set(part[1], parts);
            return false;
        }
        if (MANIFEST_RE.test(filename)) {
            manifestCache.set(message.id, url);
            hasManifest = true;
            return false;
        }
        return true;
    });

    if (hasManifest && message.content && SPLIT_CONTENT_RE.test(message.content)) message.content = "";
}

function interceptMessages(event: RawMessageEvent) {
    if (event.type !== "MESSAGE_CREATE" && event.type !== "MESSAGE_UPDATE" && event.type !== "LOAD_MESSAGES_SUCCESS") return;
    if (event.message) stripParts(event.message);
    event.messages?.forEach(stripParts);
}

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
    settings,

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
        FluxDispatcher.addInterceptor(interceptMessages);

        const container = document.createElement("div");
        container.id = "vc-nfl-root";
        document.body.appendChild(container);
        overlayRoot = createRoot(container);
        overlayRoot.render(<ProgressOverlay />);
    },

    stop() {
        for (const interceptor of [interceptAddFiles, interceptMessages]) {
            const index = FluxDispatcher._interceptors.indexOf(interceptor);
            if (index > -1) FluxDispatcher._interceptors.splice(index, 1);
        }

        overlayRoot?.unmount();
        overlayRoot = null;
        document.getElementById("vc-nfl-root")?.remove();
    },

    renderMessageAccessory(props: Record<string, any>) {
        const { message } = props as { message: Message; };
        const manifestUrl = manifestCache.get(message.id);
        if (!manifestUrl) return null;
        return <SplitAttachment message={message} manifestUrl={manifestUrl} />;
    }
});
