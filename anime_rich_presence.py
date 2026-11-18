#!/usr/bin/env python3
"""
Enhanced Anime Rich Presence - Python Desktop App
Persistent timestamps, AniList cover caching, multi-site streaming support, and robust Discord RPC lifecycle.
"""

import time
import threading
import json
import requests
import argparse
import os
import sys
import logging
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
from pypresence import Presence

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)


def load_env_file(env_path=".env"):
    """Load key=value pairs from a local .env file into os.environ if present."""
    full_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), env_path)
    if not os.path.exists(full_path):
        return
    try:
        with open(full_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except Exception as e:
        logger.warning(f"Could not read .env file: {e}")


load_env_file()


class EnhancedAnimeRichPresence:
    def __init__(self, verbose=False):
        self.client_id = os.environ.get("DISCORD_CLIENT_ID", "1421704557830078464")
        self.rpc = None
        self.is_connected = False
        self.is_connecting = False
        self.current_activity = None
        self.session_start_time = int(time.time())
        self.current_start_time = None
        self.host = os.environ.get("HOST", "localhost")
        self.port = int(os.environ.get("PORT", "3000"))
        self.verbose = verbose

        self.thumbnail_cache = {}
        self.last_logged_state = None

        self.flask_app = Flask(__name__)
        CORS(self.flask_app, origins=[
            "https://miruro.tv",
            "https://miruro.to",
            "https://miruro.cx",
            "chrome-extension://*",
            "moz-extension://*"
        ])

        self.setup_routes()
        self.connect_to_discord()

    def setup_routes(self):
        """Setup Flask API routes"""

        @self.flask_app.route('/status', methods=['GET'])
        def get_status():
            return jsonify({
                'connected': True,
                'discord': self.is_connected and self.rpc is not None,
                'activity': self.current_activity is not None,
                'current_activity': self.current_activity,
                'timestamp': datetime.now().isoformat()
            })

        @self.flask_app.route('/update', methods=['POST'])
        def update_activity():
            try:
                data = request.get_json()
                if not data:
                    return jsonify({'success': False, 'error': 'No data provided'}), 400

                is_diff = self.is_state_different(data, self.last_logged_state)
                if self.verbose or is_diff:
                    logger.info(f"RECEIVED DATA: {json.dumps(data, indent=2)}")

                self.update_discord_activity(data)

                if is_diff:
                    self.last_logged_state = data

                return jsonify({'success': True, 'message': 'Activity updated'})

            except Exception as e:
                logger.error(f"Failed to update activity: {e}")
                return jsonify({'success': False, 'error': str(e)}), 500

        @self.flask_app.route('/clear', methods=['POST'])
        def clear_activity():
            try:
                self.clear_discord_activity()
                return jsonify({'success': True, 'message': 'Activity cleared'})
            except Exception as e:
                logger.error(f"Failed to clear activity: {e}")
                return jsonify({'success': False, 'error': str(e)}), 500

    def is_state_different(self, current, last):
        if not last:
            return True
        return (
            current.get('title') != last.get('title') or
            current.get('episode') != last.get('episode') or
            current.get('isPlaying') != last.get('isPlaying') or
            current.get('isPaused') != last.get('isPaused') or
            current.get('privacyMode') != last.get('privacyMode') or
            current.get('showEpisode') != last.get('showEpisode') or
            current.get('showProgress') != last.get('showProgress') or
            current.get('showSiteBadge') != last.get('showSiteBadge')
        )

    def connect_to_discord(self):
        """Connect to Discord RPC with safe socket recovery"""
        if self.is_connected or self.is_connecting:
            return

        self.is_connecting = True

        if self.rpc:
            try:
                self.rpc.close()
            except Exception:
                pass
            self.rpc = None

        try:
            logger.info("🔗 Connecting to Discord...")
            self.rpc = Presence(self.client_id)
            self.rpc.connect()
            self.is_connected = True
            self.is_connecting = False
            logger.info("✅ Connected to Discord!")

            if self.current_activity:
                logger.info("🔄 Restoring previous activity...")
                try:
                    self.rpc.update(**self.current_activity)
                except Exception:
                    pass

        except Exception as e:
            self.is_connected = False
            self.is_connecting = False
            self.rpc = None
            logger.info(f"⏳ Discord not found ({e}). Retrying in 10 seconds...")
            threading.Timer(10.0, self.connect_to_discord).start()

    def clean_title_for_search(self, title):
        """Clean anime title to optimize AniList search query matching"""
        if not title:
            return ""
        import re
        cleaned = title
        if " - " in cleaned:
            parts = cleaned.split(" - ")
            if len(parts[0]) >= 3:
                cleaned = parts[0]
        if ":" in cleaned:
            parts = cleaned.split(":")
            if len(parts[0]) >= 3:
                cleaned = parts[0]

        cleaned = re.sub(r'\b(Prologue|Epilogue|Special|Movie|OVA|OAD|ONA|Season \d+|Part \d+|Cour \d+)\b.*', '', cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r'[\(\[\{].*?[\)\]\}]', '', cleaned)
        cleaned = ' '.join(cleaned.split())
        return cleaned.strip()

    def get_anime_thumbnail(self, anime_title):
        """Fetch anime thumbnail from AniList API with caching"""
        if anime_title in self.thumbnail_cache:
            return self.thumbnail_cache[anime_title]

        search_title = self.clean_title_for_search(anime_title)
        if not search_title:
            return None

        try:
            query = '''
            query ($search: String) {
                Media(search: $search, type: ANIME) {
                    coverImage {
                        large
                    }
                }
            }
            '''
            variables = {'search': search_title}
            response = requests.post(
                'https://graphql.anilist.co',
                json={'query': query, 'variables': variables},
                timeout=5
            )
            if response.status_code == 200:
                data = response.json()
                media = data.get('data', {}).get('Media')
                if media:
                    cover_url = media.get('coverImage', {}).get('large')
                    if cover_url:
                        logger.info(f"📸 Found thumbnail for: {anime_title}")
                        self.thumbnail_cache[anime_title] = cover_url
                        return cover_url

        except Exception as e:
            logger.warning(f"AniList lookup failed for {anime_title}: {e}")

        self.thumbnail_cache[anime_title] = None
        return None

    def update_discord_activity(self, activity_data):
        if not self.is_connected or not self.rpc:
            self.connect_to_discord()
            raise Exception("Discord is not connected")

        try:
            title = activity_data.get('title', 'Unknown Anime')
            is_playing = activity_data.get('isPlaying', True)
            is_paused = activity_data.get('isPaused', False)
            progress = activity_data.get('progress', 0)
            duration = activity_data.get('duration', 0)
            episode = activity_data.get('episode')
            site = activity_data.get('site', 'Miruro')

            privacy_mode = activity_data.get('privacyMode', False)
            show_episode = activity_data.get('showEpisode', True)
            show_progress = activity_data.get('showProgress', True)
            show_site_badge = activity_data.get('showSiteBadge', True)

            fallback_large_image = "https://i.imgur.com/Obm1W9B.png"

            if privacy_mode:
                display_title = "Watching Anime"
                display_site = "Anime"
            else:
                display_title = title
                display_site = site

            if is_paused or not is_playing:
                small_image = "pause_small"
                small_text = "Paused"
                status_emoji = "⏸️"
                playing_status = "⏸️ Paused"
            else:
                small_image = "play_small"
                small_text = "Playing"
                status_emoji = "▶️"
                playing_status = "▶️ Playing"

            discord_activity = {
                'details': f"{status_emoji} {display_title}",
                'state': self.format_episode_state(
                    activity_data,
                    is_paused or not is_playing,
                    show_episode=show_episode,
                    show_progress=show_progress,
                    show_site_badge=show_site_badge,
                    privacy_mode=privacy_mode
                ),
                'large_image': fallback_large_image,
                'large_text': display_title,
                'small_image': small_image,
                'small_text': small_text,
            }

            if show_progress and is_playing and not is_paused and progress is not None:
                calculated_start = int(time.time() - progress)
                if (self.current_start_time is None or
                    abs(self.current_start_time - calculated_start) > 3 or
                    self.last_logged_state is None or
                    self.last_logged_state.get('title') != title or
                    self.last_logged_state.get('episode') != episode):
                    self.current_start_time = calculated_start

                discord_activity['start'] = self.current_start_time
            else:
                self.current_start_time = None

            if not privacy_mode:
                thumbnail_url = activity_data.get('coverArt')
                if not thumbnail_url:
                    thumbnail_url = self.get_anime_thumbnail(title)
                if thumbnail_url:
                    discord_activity['large_image'] = thumbnail_url
                    discord_activity['large_text'] = title

            discord_activity = {k: v for k, v in discord_activity.items() if v is not None}

            self.rpc.update(**discord_activity)
            self.current_activity = discord_activity

            if self.verbose or self.is_state_different(activity_data, self.last_logged_state):
                logger.info(f"📺 Updated Discord activity: {title} - {playing_status}")

        except Exception as e:
            logger.error(f"Failed to update Discord activity: {e}")
            self.is_connected = False
            if self.rpc:
                try:
                    self.rpc.close()
                except Exception:
                    pass
                self.rpc = None
            threading.Timer(5.0, self.connect_to_discord).start()
            raise

    def format_episode_state(self, activity_data, is_paused_state, show_episode=True, show_progress=True, show_site_badge=True, privacy_mode=False):
        parts = []
        if is_paused_state:
            parts.append("Paused")

        if show_episode and activity_data.get('episode') is not None and not privacy_mode:
            parts.append(f"Episode {activity_data['episode']}")

        if show_progress and activity_data.get('progress') is not None and activity_data.get('duration') and not privacy_mode:
            progress_time = self.format_time(activity_data['progress'])
            duration_time = self.format_time(activity_data['duration'])
            progress_percent = min(100, max(0, int((activity_data['progress'] / activity_data['duration']) * 100)))
            parts.append(f"{progress_time} / {duration_time} ({progress_percent}%)")

        if show_site_badge:
            site = activity_data.get('site', 'Miruro') if not privacy_mode else 'Anime'
            parts.append(site)

        return " • ".join(parts) if parts else "Watching"

    def format_time(self, seconds):
        if not seconds or seconds < 0:
            return "0:00"
        mins = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{mins}:{secs:02d}"

    def clear_discord_activity(self):
        if not self.is_connected or not self.rpc:
            return

        try:
            self.rpc.clear()
            self.current_activity = None
            logger.info("🧹 Cleared Discord activity")
        except Exception as e:
            logger.error(f"Failed to clear Discord activity: {e}")
            self.is_connected = False
            if self.rpc:
                try:
                    self.rpc.close()
                except Exception:
                    pass
                self.rpc = None
            threading.Timer(5.0, self.connect_to_discord).start()

    def run(self):
        logger.info(f"🚀 Starting Enhanced Anime Rich Presence server on http://{self.host}:{self.port}")
        logger.info(f"🔌 Caching: Enabled. Verbose logs: {'Enabled' if self.verbose else 'Disabled (State changes only)'}")

        try:
            self.flask_app.run(
                host=self.host,
                port=self.port,
                debug=False,
                use_reloader=False
            )
        except KeyboardInterrupt:
            logger.info("\n🛑 Shutting down...")
            self.cleanup()

    def cleanup(self):
        if self.rpc and self.is_connected:
            try:
                self.rpc.clear()
                self.rpc.close()
            except Exception:
                pass
        logger.info("👋 Goodbye!")

def main():
    parser = argparse.ArgumentParser(description="Enhanced Anime Rich Presence")
    parser.add_argument('--verbose', action='store_true', help='Enable verbose progress logging')
    args = parser.parse_args()

    print("🎌 Enhanced Anime Rich Presence")
    print("=" * 50)
    print("Features:")
    print("• Persistent green timestamp")
    print("• Progress time display")
    print("• Dynamic anime thumbnails from AniList (cached)")
    print("• Multi-site support: Miruro & AnimePahe")
    print("=" * 50)

    app = EnhancedAnimeRichPresence(verbose=args.verbose)
    try:
        app.run()
    except Exception as e:
        logger.error(f"Fatal server error: {e}")
        return 1
    return 0

if __name__ == "__main__":
    exit(main())
