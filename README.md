# NoFileLimit

An [Equicord](https://github.com/Equicord/Equicord) userplugin that lets you send files bigger than Discord's upload limit.

## How it works

- Drop, paste or attach a file that is over your upload limit. Instead of the "file too large" popup, the plugin splits it into parts just under the limit and sends them automatically, 10 parts per message.
- A small `nfl_<id>.json` manifest is sent with the last message. It holds the original file name, size and a SHA-256 hash of every part.
- Anyone with the plugin sees one attachment with the original file name instead of the parts. Videos, images and audio play right in chat, and the **Download** button saves the original file. Every part is checked against its hash.
- Files under the limit upload normally.

## Settings

- **Split size (MB)**: size of each part. `0` picks the largest size your upload limit allows.
- **Show progress**: shows upload and download progress in the top right corner.
- **Auto load (MB)**: videos, images and audio up to this size load automatically so they play in chat. `0` means you always click **Play** first.

People without the plugin can merge the parts by hand.

Windows:

```
copy /b nfl_<id>_*.part original.ext
```

Linux / macOS:

```
cat nfl_<id>_*.part > original.ext
```

## Install

1. Clone the Equicord source and set it up (see the [Equicord docs](https://github.com/Equicord/Equicord)).
2. Clone this repository into `src/userplugins/noFileLimit`:
   ```
   git clone https://github.com/greenythebeany/NoFileLimit src/userplugins/noFileLimit
   ```
3. Run `pnpm build`, then `pnpm inject`, and restart Discord.
4. Enable **NoFileLimit** in Settings → Equicord → Plugins.

## Notes

- The merged file is assembled in memory, so very large files (several GB) may fail.
- Sending many parts quickly can hit Discord's rate limits. The plugin waits between messages.
- Client mods are against Discord's Terms of Service. Use at your own risk.
