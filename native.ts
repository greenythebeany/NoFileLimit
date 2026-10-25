/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MAX_BYTES = 600 * 1024 * 1024;

export async function fetchAttachment(_: IpcMainInvokeEvent, url: unknown): Promise<{ success: true; data: Uint8Array; } | { success: false; error: string; }> {
    if (typeof url !== "string" || url.length > 4096) return { success: false, error: "Invalid attachment URL." };

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { success: false, error: "Invalid attachment URL." };
    }
    if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname) || !parsed.pathname.startsWith("/attachments/"))
        return { success: false, error: "Only Discord attachments can be downloaded." };

    try {
        const res = await fetch(parsed, { redirect: "error" });
        if (!res.ok) return { success: false, error: `Download failed with status ${res.status}.` };
        if (Number(res.headers.get("content-length")) > MAX_BYTES) return { success: false, error: "Part is too large." };

        const data = new Uint8Array(await res.arrayBuffer());
        if (data.byteLength > MAX_BYTES) return { success: false, error: "Part is too large." };
        return { success: true, data };
    } catch {
        return { success: false, error: "Download failed." };
    }
}
