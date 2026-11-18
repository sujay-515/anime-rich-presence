# Discord Anime Rich Presence

Show what anime you're watching on Discord with Rich Presence for Miruro.

## Features

- Real-time anime detection on Miruro
- Dynamic thumbnails from AniList API
- Episode and progress tracking
- Cross-platform (macOS and Windows)

## Setup

### 1. Download This Project

Click the green Code button, select Download ZIP, and extract it.

### 2. Discord Application Setup

1. Go to discord.com/developers/applications
2. Create new application and copy the Application ID
3. Edit anime_rich_presence.py line 27 with your ID

### 3. Install Dependencies

macOS: Open Terminal and run these commands one by one:
cd path/to/extracted/folder
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

Windows: Open Command Prompt and run these commands one by one:
cd path\to\extracted\folder
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt

### 4. Install Browser Extension

1. Open chrome://extensions/
2. Enable Developer mode
3. Click Load unpacked
4. Select browser-extension folder

### 5. Run

macOS: source venv/bin/activate then python anime_rich_presence.py
Windows: venv\Scripts\activate then python anime_rich_presence.py

Open Discord desktop app and play anime on Miruro.

## Troubleshooting

- Use Discord desktop app not web
- Restart Discord then server if connection fails
- Reload extension if not detecting

## Credits

Created by Sujay

## License

MIT License
