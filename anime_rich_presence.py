#!/usr/bin/env python3
"""
Enhanced Anime Rich Presence - Python Desktop App
Single-thread Discord RPC worker, active socket heartbeat, AniList cover caching,
smart rate-limiting, and seamless auto-reconnection.
"""

import argparse
import asyncio
import json
import logging
import os
import queue
import re
import threading
import time
from datetime import datetime
from flask import Flask, Response, request, jsonify
from flask_cors import CORS
from pypresence import Presence
from pypresence.types import ActivityType, StatusDisplayType
import requests

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
    HEARTBEAT_INTERVAL = 3.0
    DISCORD_UPDATE_MIN_INTERVAL = 15.0

    def __init__(self, verbose=False):
        self.client_id = os.environ.get("DISCORD_CLIENT_ID", "1421704557830078464")
        self.host = os.environ.get("HOST", "localhost")
        self.port = int(os.environ.get("PORT", "3000"))
        self.verbose = verbose

        activity_map = {
            "playing": ActivityType.PLAYING,
            "listening": ActivityType.LISTENING,
            "watching": ActivityType.WATCHING,
            "competing": ActivityType.COMPETING,
        }
        status_display_map = {
            "name": StatusDisplayType.NAME,
            "state": StatusDisplayType.STATE,
            "details": StatusDisplayType.DETAILS,
        }
        self.activity_type = activity_map.get(
            os.environ.get("DISCORD_ACTIVITY_TYPE", "watching").strip().lower(),
            ActivityType.WATCHING,
        )
        self.status_display_type = status_display_map.get(
            os.environ.get("DISCORD_STATUS_DISPLAY", "details").strip().lower(),
            StatusDisplayType.DETAILS,
        )
        self.activity_name = os.environ.get("DISCORD_ACTIVITY_NAME", "Anime").strip() or None
        self.use_progress_bar = os.environ.get("DISCORD_PROGRESS_BAR", "true").strip().lower() in ("1", "true", "yes")
        self.use_session_timer = os.environ.get("DISCORD_SESSION_TIMER", "true").strip().lower() in ("1", "true", "yes")
        self.session_start_time = None
        self.last_session_label = None

        self.rpc = None
        self.rpc_loop = None
        self.is_connected = False
        self._waiting_logged = False
        self._stop_event = threading.Event()
        self._state_lock = threading.Lock()
        self._sse_lock = threading.Lock()
        self._sse_clients = set()
        self.rpc_queue = queue.Queue()

        self.current_activity = None
        self.pending_raw_data = None
        self.last_discord_push_time = 0.0
        self.last_discord_raw = None
        self.current_start_time = None

        self.thumbnail_cache = {}
        self.last_logged_state = None

        self.flask_app = Flask(__name__)
        CORS(self.flask_app, origins=[
            "https://reanime.cz",
            "https://kotoplay.to",
            "https://miruro.tv",
            "https://miruro.to",
            "https://miruro.cx",
            "https://www.miruro.cx",
            "https://gotaku.to",
            "https://animepahe.pw",
            "chrome-extension://*",
            "moz-extension://*"
        ])

        self.setup_routes()

        # Start dedicated single-thread Discord RPC worker
        self.rpc_thread = threading.Thread(target=self._rpc_worker, name="DiscordRPCWorker", daemon=True)
        self.rpc_thread.start()

    def _get_status_payload(self):
        with self._state_lock:
            return {
                'connected': True,
                'discord': self.is_connected,
                'activity': self.current_activity is not None,
                'current_activity': self.current_activity,
                'timestamp': datetime.now().isoformat()
            }

    def _broadcast_status(self):
        payload = json.dumps(self._get_status_payload())
        with self._sse_lock:
            clients = list(self._sse_clients)
        for q in clients:
            try:
                if q.full():
                    try:
                        q.get_nowait()
                    except queue.Empty:
                        pass
                q.put_nowait(payload)
            except Exception:
                pass

    def setup_routes(self):
        """Setup Flask API routes."""

        @self.flask_app.route('/status', methods=['GET'])
        def get_status():
            return jsonify(self._get_status_payload())

        @self.flask_app.route('/events', methods=['GET'])
        def stream_events():
            client_queue = queue.Queue(maxsize=16)
            with self._sse_lock:
                self._sse_clients.add(client_queue)

            def event_stream():
                try:
                    yield f"data: {json.dumps(self._get_status_payload())}\n\n"
                    while not self._stop_event.is_set():
                        try:
                            msg = client_queue.get(timeout=15.0)
                            if msg is None:
                                break
                            yield f"data: {msg}\n\n"
                        except queue.Empty:
                            yield ": keepalive\n\n"
                finally:
                    with self._sse_lock:
                        self._sse_clients.discard(client_queue)

            return Response(
                event_stream(),
                mimetype='text/event-stream',
                headers={
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                }
            )

        @self.flask_app.route('/update', methods=['POST'])
        def update_activity():
            try:
                data = request.get_json()
                if not data or not data.get('title'):
                    return jsonify({'success': False, 'error': 'No valid activity data provided'}), 400

                is_diff = self.is_state_different(data, self.last_logged_state)
                if self.verbose or is_diff:
                    logger.info(f"RECEIVED DATA: {json.dumps(data, indent=2)}")

                if is_diff:
                    self.last_logged_state = data

                with self._state_lock:
                    self.pending_raw_data = data
                    discord_ready = self.is_connected

                if self._should_push_to_discord(data):
                    self.rpc_queue.put(('update', data))

                return jsonify({
                    'success': True,
                    'discord': discord_ready,
                    'queued': not discord_ready
                })

            except Exception as e:
                logger.error(f"Failed to handle update request: {e}")
                return jsonify({'success': False, 'error': str(e)}), 500

        @self.flask_app.route('/clear', methods=['POST'])
        def clear_activity():
            try:
                with self._state_lock:
                    self.pending_raw_data = None
                    self.current_activity = None
                    self.last_discord_raw = None
                    self.current_start_time = None
                    self.session_start_time = None
                    self.last_session_label = None
                    self.last_logged_state = None

                self.rpc_queue.put(('clear', None))
                return jsonify({'success': True, 'message': 'Activity cleared'})
            except Exception as e:
                logger.error(f"Failed to handle clear request: {e}")
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

    def _should_push_to_discord(self, data):
        """Push immediately on state changes or seeks; throttle routine playback ticks."""
        if self.last_discord_raw is None:
            return True
        if self.is_state_different(data, self.last_discord_raw):
            return True
        if (data.get('duration') or 0) != (self.last_discord_raw.get('duration') or 0):
            return True

        # Detect user seek by comparing progress delta vs elapsed wall time
        now = time.time()
        elapsed = now - self.last_discord_push_time
        prev_progress = self.last_discord_raw.get('progress') or 0
        curr_progress = data.get('progress') or 0
        is_playing = data.get('isPlaying', True) and not data.get('isPaused', False)

        if is_playing:
            expected_progress = prev_progress + elapsed
            if abs(curr_progress - expected_progress) > 4.0:
                return True
        else:
            if abs(curr_progress - prev_progress) > 2.0:
                return True

        # Push when custom session timer minute label rolls over (when using native bar)
        if self.use_progress_bar and self.use_session_timer and self.session_start_time is not None:
            curr_label = self.format_session_duration(int(now) - self.session_start_time)
            if curr_label != self.last_session_label:
                return True
            return False

        return elapsed >= self.DISCORD_UPDATE_MIN_INTERVAL

    # ------------------------------------------------------------------
    # Dedicated Single-Thread Discord RPC Worker
    # ------------------------------------------------------------------
    def _ensure_worker_loop(self):
        if self.rpc_loop is None or self.rpc_loop.is_closed():
            self.rpc_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.rpc_loop)

    def _close_rpc_socket(self):
        if self.rpc:
            try:
                self.rpc.close()
            except Exception:
                pass
            self.rpc = None
        if self.rpc_loop and not self.rpc_loop.is_closed():
            try:
                self.rpc_loop.close()
            except Exception:
                pass
        self.rpc_loop = None

    def _try_connect_discord(self):
        if self.is_connected:
            return True

        self._close_rpc_socket()
        self._ensure_worker_loop()

        try:
            if not self._waiting_logged:
                logger.info("🔗 Connecting to Discord...")
            client = Presence(self.client_id)
            client.connect()
            self.rpc = client
            with self._state_lock:
                self.is_connected = True
            self._waiting_logged = False
            logger.info("✅ Connected to Discord!")
            self._broadcast_status()

            # Restore pending anime if user already has a watch page open
            with self._state_lock:
                pending = self.pending_raw_data
            if pending:
                logger.info("🔄 Syncing active anime to Discord...")
                self._send_discord_update(pending)
            return True
        except Exception as e:
            self._close_rpc_socket()
            with self._state_lock:
                self.is_connected = False
            if not self._waiting_logged:
                logger.info(f"⏳ Waiting for Discord ({e}). Checking every {int(self.HEARTBEAT_INTERVAL)}s...")
                self._waiting_logged = True
            return False

    def _check_discord_alive(self):
        """Check whether the underlying Discord IPC pipe is still open."""
        if not self.is_connected or not self.rpc:
            return False
        try:
            if self.rpc_loop and not self.rpc_loop.is_closed():
                self.rpc_loop.run_until_complete(asyncio.sleep(0.01))
            reader = getattr(self.rpc, 'sock_reader', None)
            writer = getattr(self.rpc, 'sock_writer', None)
            if reader is None or writer is None or reader.at_eof() or writer.is_closing():
                raise ConnectionResetError("Discord IPC pipe closed")
            return True
        except Exception as e:
            logger.info(f"🔌 Discord disconnected ({e}). Waiting for reconnect...")
            with self._state_lock:
                self.is_connected = False
            self._waiting_logged = True
            self._close_rpc_socket()
            self._broadcast_status()
            return False

    def _rpc_worker(self):
        """Single thread owning all pypresence calls and asyncio loop."""
        self._ensure_worker_loop()
        self._try_connect_discord()

        while not self._stop_event.is_set():
            try:
                cmd, payload = self.rpc_queue.get(timeout=self.HEARTBEAT_INTERVAL)
            except queue.Empty:
                if self.is_connected:
                    self._check_discord_alive()
                else:
                    self._try_connect_discord()
                continue

            if cmd == 'shutdown':
                break

            # Coalesce queued updates so bursts only send the freshest state
            if cmd in ('update', 'clear'):
                while True:
                    try:
                        next_cmd, next_payload = self.rpc_queue.get_nowait()
                        if next_cmd == 'shutdown':
                            cmd = 'shutdown'
                            break
                        cmd, payload = next_cmd, next_payload
                    except queue.Empty:
                        break
                if cmd == 'shutdown':
                    break

            if not self.is_connected:
                self._try_connect_discord()

            if cmd == 'update' and self.is_connected:
                self._send_discord_update(payload)
            elif cmd == 'clear' and self.is_connected:
                self._send_discord_clear()

        self._send_discord_clear()
        self._close_rpc_socket()

    # ------------------------------------------------------------------
    # Formatting & AniList Lookup
    # ------------------------------------------------------------------
    def clean_title_for_search(self, title):
        """Clean anime title to optimize AniList search query matching."""
        if not title:
            return ""
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
        """Fetch anime thumbnail from AniList API with caching."""
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
            response = requests.post(
                'https://graphql.anilist.co',
                json={'query': query, 'variables': {'search': search_title}},
                timeout=5
            )
            if response.status_code == 200:
                media = response.json().get('data', {}).get('Media')
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

    def _send_discord_update(self, activity_data):
        if not self.is_connected or not self.rpc or not activity_data:
            return

        try:
            title = activity_data.get('title', 'Unknown Anime')
            is_playing = activity_data.get('isPlaying', True)
            is_paused = activity_data.get('isPaused', False)
            progress = activity_data.get('progress', 0)
            duration = activity_data.get('duration', 0) or 0
            episode = activity_data.get('episode')

            privacy_mode = activity_data.get('privacyMode', False)
            show_episode = activity_data.get('showEpisode', True)
            show_progress = activity_data.get('showProgress', True)
            show_site_badge = activity_data.get('showSiteBadge', True)

            fallback_large_image = "https://i.imgur.com/Obm1W9B.png"
            display_title = "Watching Anime" if privacy_mode else title

            if is_paused or not is_playing:
                small_image = "pause_small"
                small_text = "Paused"
                playing_status = "⏸️ Paused"
            else:
                small_image = "play_small"
                small_text = "Playing"
                playing_status = "▶️ Playing"

            details_text = display_title if self.activity_type == ActivityType.WATCHING else f"{'⏸️' if (is_paused or not is_playing) else '▶️'} {display_title}"

            discord_activity = {
                'activity_type': self.activity_type,
                'status_display_type': StatusDisplayType.NAME if privacy_mode else self.status_display_type,
                'name': self.activity_name,
                'details': details_text,
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

            if self.session_start_time is None:
                self.session_start_time = int(time.time())

            if self.use_progress_bar and not privacy_mode and show_progress and is_playing and not is_paused and progress is not None and duration > 0:
                calculated_start = int(time.time() - progress)
                if (self.current_start_time is None or
                    abs(self.current_start_time - calculated_start) > 3 or
                    self.last_discord_raw is None or
                    self.last_discord_raw.get('title') != title or
                    self.last_discord_raw.get('episode') != episode):
                    self.current_start_time = calculated_start
                discord_activity['start'] = self.current_start_time
                discord_activity['end'] = self.current_start_time + int(duration)
            else:
                self.current_start_time = None
                # Keep persistent session timestamp when paused so Discord's timer never resets to 0:00
                discord_activity['start'] = self.session_start_time

            if not privacy_mode:
                thumbnail_url = activity_data.get('coverArt') or self.get_anime_thumbnail(title)
                if thumbnail_url:
                    discord_activity['large_image'] = thumbnail_url
                    discord_activity['large_text'] = title

            # Abort if /clear was called while waiting on AniList network lookup
            with self._state_lock:
                if self.pending_raw_data is None:
                    return

            discord_activity = {k: v for k, v in discord_activity.items() if v is not None}

            self.rpc.update(**discord_activity)

            state_changed = self.is_state_different(activity_data, self.last_discord_raw)
            with self._state_lock:
                self.current_activity = discord_activity
                self.last_discord_raw = activity_data
                self.last_discord_push_time = time.time()
                if self.session_start_time is not None:
                    self.last_session_label = self.format_session_duration(int(time.time()) - self.session_start_time)

            if self.verbose or state_changed:
                logger.info(f"📺 Updated Discord activity: {title} - {playing_status}")
            self._broadcast_status()

        except Exception as e:
            logger.warning(f"🔌 Discord update failed ({e}). Reconnecting...")
            with self._state_lock:
                self.is_connected = False
            self._waiting_logged = True
            self._close_rpc_socket()
            self._broadcast_status()

    def _send_discord_clear(self):
        with self._state_lock:
            self.current_activity = None
            self.last_discord_raw = None
            self.current_start_time = None
        if not self.is_connected or not self.rpc:
            return
        try:
            self.rpc.clear()
            logger.info("🧹 Cleared Discord activity")
            self._broadcast_status()
        except Exception as e:
            logger.warning(f"🔌 Discord clear failed ({e}). Marking disconnected...")
            with self._state_lock:
                self.is_connected = False
            self._waiting_logged = True
            self._close_rpc_socket()
            self._broadcast_status()

    def format_session_duration(self, seconds):
        if not seconds or seconds < 60:
            return "<1m"
        total_mins = int(seconds // 60)
        hours, mins = divmod(total_mins, 60)
        if hours > 0:
            return f"{hours}h {mins}m"
        return f"{mins}m"

    def format_episode_state(self, activity_data, is_paused_state, show_episode=True, show_progress=True, show_site_badge=True, privacy_mode=False):
        parts = []
        if is_paused_state:
            parts.append("Paused")

        if show_episode and activity_data.get('episode') is not None and not privacy_mode:
            parts.append(f"Episode {activity_data['episode']}")

        # Show text progress fallback when paused, using persistent timer, or when duration isn't available yet
        has_native_bar = self.use_progress_bar and show_progress and (not is_paused_state) and bool(activity_data.get('duration'))
        if show_progress and not has_native_bar and activity_data.get('progress') is not None and activity_data.get('duration') and not privacy_mode:
            progress_time = self.format_time(activity_data['progress'])
            duration_time = self.format_time(activity_data['duration'])
            progress_percent = min(100, max(0, int((activity_data['progress'] / activity_data['duration']) * 100)))
            parts.append(f"{progress_time} / {duration_time} ({progress_percent}%)")

        if show_site_badge:
            site = activity_data.get('site', 'Miruro') if not privacy_mode else 'Anime'
            parts.append(site)

        # Show custom watch-session timer in state while native progress bar occupies timestamps
        if self.use_session_timer and has_native_bar and not privacy_mode and self.session_start_time is not None:
            session_label = self.format_session_duration(int(time.time()) - self.session_start_time)
            parts.append(f"⏱ {session_label}")

        return " • ".join(parts) if parts else "Watching"

    def format_time(self, seconds):
        if not seconds or seconds < 0:
            return "0:00"
        mins = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{mins}:{secs:02d}"

    def run(self):
        logger.info(f"🚀 Starting Enhanced Anime Rich Presence server on http://{self.host}:{self.port}")
        logger.info(f"🔌 Caching: Enabled. Verbose logs: {'Enabled' if self.verbose else 'Disabled (State changes only)'}")

        try:
            self.flask_app.run(
                host=self.host,
                port=self.port,
                debug=False,
                use_reloader=False,
                threaded=True
            )
        except KeyboardInterrupt:
            logger.info("\n🛑 Shutting down...")
            self.cleanup()

    def cleanup(self):
        self._stop_event.set()
        with self._sse_lock:
            for q in self._sse_clients:
                try:
                    q.put_nowait(None)
                except Exception:
                    pass
        self.rpc_queue.put(('shutdown', None))
        if self.rpc_thread.is_alive():
            self.rpc_thread.join(timeout=2.0)
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
    print("• Multi-site support: Re:Anime, KotoPlay, Miruro, Gotaku & AnimePahe")
    print("• Thread-safe Discord RPC worker with active heartbeat")
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
