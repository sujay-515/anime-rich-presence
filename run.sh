#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "🎌 Starting Anime Rich Presence..."

if [ -f "$DIR/venv/bin/python" ]; then
    PYTHON="$DIR/venv/bin/python"
elif [ -f "$DIR/../anime-rich-presence copy/venv/bin/python" ]; then
    PYTHON="$DIR/../anime-rich-presence copy/venv/bin/python"
else
    PYTHON="python3"
fi

echo "Using Python: $PYTHON"
"$PYTHON" anime_rich_presence.py "$@"
