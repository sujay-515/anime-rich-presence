#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

if [ -f "$DIR/../anime-rich-presence copy/venv/bin/python" ]; then
    PYTHON="$DIR/../anime-rich-presence copy/venv/bin/python"
elif [ -d "$DIR/venv" ]; then
    PYTHON="$DIR/venv/bin/python"
else
    PYTHON="python3"
fi

while true; do
    "$PYTHON" anime_rich_presence.py
    echo "Service stopped, restarting in 10 seconds..."
    sleep 10
done
