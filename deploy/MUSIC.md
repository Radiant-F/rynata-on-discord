# Music player

Commands start with `ryn` (change it with `MUSIC_PREFIX` in `.env`). Say `ryn help` in Discord for the list.

| Command | What it does |
| --- | --- |
| `ryn play <link or song name>` (`p`) | Plays it, or adds it to the queue if something is playing. Playlists are queued whole. |
| `ryn playnext <link or name>` (`pn`) | Puts it first in the queue |
| `ryn search <name>` | Shows 5 results with buttons to pick one |
| `ryn pause` / `resume` / `skip` (`s`) / `skipto <n>` / `stop` | Controls. `stop` also clears the queue |
| `ryn queue [page]` (`q`) / `nowplaying` (`np`) | See what's coming / what's playing |
| `ryn remove <n>` / `clear` / `shuffle` / `loop [off\|track\|queue]` | Manage the queue |
| `ryn join` / `leave` (`dc`) | Come to your voice channel / go away |

Controls only work for people in the same voice channel as the bot. Volume: right-click the bot in the voice channel.

While a song is being found and opened (a few seconds), its message says **⏳ Loading…** and an hourglass sits on your
command. When the audio really starts, the message becomes **Now playing**. `ryn nowplaying` shows the progress bar.

## What works
- YouTube and YouTube Music videos and playlists, SoundCloud, Bandcamp (anything yt-dlp can read from those sites).
- Spotify tracks, albums and playlists. Spotify doesn't give out audio, so each song is looked up on YouTube when its turn
  comes. The match is by name and length, and is usually right, but not always.
- Plain text: `ryn play never gonna give you up` plays the first YouTube result.
- Any YouTube link with `list=` in it counts as a playlist link, including `watch?v=…&list=…`. The whole playlist is
  queued (up to 100 songs, `MUSIC_MAX_PLAYLIST`), and `&index=5` starts from the 5th entry. To add just one video,
  send the link without `&list=…`.
- YouTube **Mix** links (`list=RD…`, the auto-made radio) never end, so only the first 20 songs are queued
  (`MUSIC_MIX_SIZE`).
- Links from other sites are refused on purpose: yt-dlp would otherwise fetch any address it's given, including
  devices on your home network. Add sites with `MUSIC_EXTRA_HOSTS`.

## Setup
- **Docker:** nothing to do. The image contains ffmpeg and yt-dlp, and the bot updates yt-dlp every 12 hours.
- **Without Docker (Ubuntu):**
  ```bash
  sudo apt install ffmpeg curl
  sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
  ```
  (use `yt-dlp_linux_aarch64` on ARM). Node 22.12 or newer is required.
- The bot needs to be allowed to **Connect** and **Speak** in the voice channel. No new switches in the Developer Portal.

## If something goes wrong
- `docker compose logs -f` shows what the bot sees. On start it prints the yt-dlp and ffmpeg versions, or says what's missing.
- **"YouTube is asking this server to prove it isn't a bot"** (or an age-restricted video): YouTube wants a login.
  Export your cookies in the Netscape `cookies.txt` format with a browser extension, save the file as `data/cookies.txt`,
  and add `YTDLP_COOKIES=/app/data/cookies.txt` to `.env`. Use a spare Google account, not your main one:
  yt-dlp warns that accounts used this way can get banned. Then `docker compose up -d`.
- **Everything suddenly fails after it worked:** YouTube changed something. Restart the bot (it checks for a new yt-dlp
  on start and every 12 hours), or rebuild: `docker compose build --no-cache && docker compose up -d`.
- **Joins but no sound:** check the bot isn't server-muted, and look at the log for ffmpeg errors.

## Good to know
YouTube's terms of service don't allow downloading audio this way, which is why big public music bots were shut down.
A private bot for your own server is a different scale, but keep it to that.
