# NoFileLimit

An [Equicord](https://github.com/Equicord/Equicord) userplugin that lets you send files bigger than Discord's upload limit.

## How it works

- Drop, paste or attach a file that is over your upload limit. Instead of the "file too large" popup, the plugin splits it into parts just under the limit and sends them automatically, 10 parts per message.
- A small `nfl_<id>.json` manifest is sent with the last message. It holds the original file name, size and a SHA-256 hash of every part.
- Anyone with the plugin gets a **Download merged file** button on that message. It finds the parts, checks every hash and saves the original file.
- Files under the limit upload normally.

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
