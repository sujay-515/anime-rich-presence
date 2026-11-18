#!/usr/bin/env python3
"""
Enhanced Anime Rich Presence - Python Desktop App
Persistent timestamp, includes progress time display, and caching optimizations.
"""

import time
import threading
import json
import requests
import argparse
import os
import sys
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
from pypresence import Presence
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

class EnhancedAnimeRichPresence:
    def __init__(self, verbose=False):
        self.client_id = "1421704557830078464"
        self.rpc = None
        self.is_connected = False
        self.is_connecting = False
        self.current_activity = None
        self.session_start_time = int(time.time())  # Fixed session start time
        self.current_start_time = None  # Tracks active playback start time
        self.host = 'localhost'
        self.port = 3000
        self.verbose = verbose
        
        # Caching and log verbosity helper states
        self.thumbnail_cache = {}
        self.last_logged_state = None
        
        self.flask_app = Flask(__name__)
        CORS(self.flask_app, origins=[
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
                'connected': self.is_connected,
                'discord': self.rpc is not None,
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
        """Check if incoming playback status differs from previous state (excluding progress timeline ticks)"""
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
        """Connect to Discord RPC"""
        if self.is_connected:
            return
        if self.is_connecting:
            return

        self.is_connecting = True
        
        # Clean up the old broken socket connection first
        if self.rpc:
            logger.info("🧹 Closing old Discord RPC socket connection...")
            try:
                self.rpc.close()
            except:
                pass
            self.rpc = None
            
        try:
            logger.info("🔗 Connecting to Discord...")
            self.rpc = Presence(self.client_id)
            self.rpc.connect()
            self.is_connected = True
            self.is_connecting = False
            logger.info("✅ Connected to Discord!")

            # Auto-restore presence on reconnection
            if self.current_activity:
                logger.info("🔄 Restoring active presence after Discord reconnection...")
                try:
                    self.rpc.update(**self.current_activity)
                except Exception as ex:
                    logger.warning(f"Could not restore activity presence: {ex}")

        except Exception as e:
            logger.error(f"❌ Failed to connect to Discord: {e}")
            self.is_connected = False
            self.is_connecting = False
            self.rpc = None
            logger.info("🔄 Will retry in 10 seconds...")
            threading.Timer(10.0, self.connect_to_discord).start()

    def clean_title_for_search(self, title):
        """Clean anime title to optimize AniList search query matching"""
        if not title:
            return ""
        import re
        cleaned = title
        
        # Remove colon/dash subtitles if the base title is long enough
        if " - " in cleaned:
            parts = cleaned.split(" - ")
            if len(parts[0]) >= 3:
                cleaned = parts[0]
        if ":" in cleaned:
            parts = cleaned.split(":")
            if len(parts[0]) >= 3:
                cleaned = parts[0]
                
        # Remove common subtitles, formats, and tags
        cleaned = re.sub(r'\b(Prologue|Epilogue|Special|Movie|OVA|OAD|ONA|Season \d+|Part \d+|Cour \d+)\b.*', '', cleaned, flags=re.IGNORECASE)
        # Strip empty brackets and parentheses
        cleaned = re.sub(r'[\(\[\{].*?[\)\]\}]', '', cleaned)
        # Normalize double spaces
        cleaned = ' '.join(cleaned.split())
        return cleaned.strip()

    def get_anime_thumbnail(self, anime_title):
        """Fetch anime thumbnail from AniList API with caching support"""
        if anime_title in self.thumbnail_cache:
            return self.thumbnail_cache[anime_title]
            
        search_title = self.clean_title_for_search(anime_title)
        if not search_title:
            return None
            
        try:
            # AniList GraphQL query
            query = '''
            query ($search: String) {
                Media(search: $search, type: ANIME) {
                    title {
                        romaji
                        english
                    }
                    coverImage {
                        large
                        medium
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
                        logger.info(f"📸 Found thumbnail for: {anime_title} (via search: {search_title})")
                        self.thumbnail_cache[anime_title] = cover_url
                        return cover_url
                        
        except Exception as e:
            logger.warning(f"Failed to fetch thumbnail for {anime_title}: {e}")
        
        # Cache None for search queries that returned no cover art to prevent query spam
        self.thumbnail_cache[anime_title] = None
        return None

    def update_discord_activity(self, activity_data):
        """Update Discord Rich Presence activity with persistent timestamp"""
        if not self.is_connected or not self.rpc:
            raise Exception("Not connected to Discord")
        
        try:
            title = activity_data.get('title', 'Unknown Anime')
            is_playing = activity_data.get('isPlaying', True)
            is_paused = activity_data.get('isPaused', False)
            progress = activity_data.get('progress', 0)
            duration = activity_data.get('duration', 0)
            episode = activity_data.get('episode')
            site = activity_data.get('site', 'Miruro')
            
            # Formatting options passed from extension
            privacy_mode = activity_data.get('privacyMode', False)
            show_episode = activity_data.get('showEpisode', True)
            show_progress = activity_data.get('showProgress', True)
            show_site_badge = activity_data.get('showSiteBadge', True)
            
            fallback_large_image = "https://i.imgur.com/Obm1W9B.png" # Public fallback anime icon
            
            if privacy_mode:
                title = "Watching Anime"
                episode = None
                show_progress = False
                show_site_badge = False
                site = "Anime"
            
            # Determine status
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
            
            # Create activity structure
            discord_activity = {
                'details': f"{status_emoji} {title}",
                'state': self.format_episode_state(
                    activity_data, 
                    is_paused or not is_playing,
                    show_episode=show_episode,
                    show_progress=show_progress,
                    show_site_badge=show_site_badge,
                    privacy_mode=privacy_mode
                ),
                'large_image': fallback_large_image,
                'large_text': title,
                'small_image': small_image,
                'small_text': small_text,
            }
            
            # Show elapsed time only if playing and we want to show progress
            if show_progress and is_playing and not is_paused and progress is not None:
                calculated_start = int(time.time() - progress)
                
                # Update start time if unset, if state changes, or if user seeked
                if (self.current_start_time is None or 
                    abs(self.current_start_time - calculated_start) > 3 or
                    self.last_logged_state is None or
                    self.last_logged_state.get('title') != title or
                    self.last_logged_state.get('episode') != episode):
                    self.current_start_time = calculated_start
                
                discord_activity['start'] = self.current_start_time
            else:
                self.current_start_time = None
            
            # Only fetch thumbnail if not in privacy mode
            if not privacy_mode:
                thumbnail_url = activity_data.get('coverArt')
                if not thumbnail_url:
                    thumbnail_url = self.get_anime_thumbnail(title)
                if thumbnail_url:
                    discord_activity['large_image'] = thumbnail_url
                    discord_activity['large_text'] = title
            else:
                discord_activity['large_image'] = fallback_large_image
                discord_activity['large_text'] = 'Anime'
            
            # Remove None values
            discord_activity = {k: v for k, v in discord_activity.items() if v is not None}
            
            self.rpc.update(**discord_activity)
            self.current_activity = discord_activity
            
            if self.verbose or self.is_state_different(activity_data, self.last_logged_state):
                logger.info(f"📺 Updated Discord activity: {title} - {playing_status}")
            
        except Exception as e:
            logger.error(f"Failed to update Discord activity: {e}")
            self.is_connected = False
            self.connect_to_discord()
            raise

    def format_episode_state(self, activity_data, is_paused_state, show_episode=True, show_progress=True, show_site_badge=True, privacy_mode=False):
        """Format episode and progress information with custom toggles"""
        parts = []
        
        # Add pause status if paused
        if is_paused_state:
            parts.append("Paused")
        
        # Add episode info
        if show_episode and activity_data.get('episode') is not None and not privacy_mode:
            parts.append(f"Episode {activity_data['episode']}")
        
        # Add progress time display
        if show_progress and activity_data.get('progress') is not None and activity_data.get('duration') and not privacy_mode:
            progress_time = self.format_time(activity_data['progress'])
            duration_time = self.format_time(activity_data['duration'])
            progress_percent = min(100, max(0, int((activity_data['progress'] / activity_data['duration']) * 100)))
            parts.append(f"{progress_time} / {duration_time} ({progress_percent}%)")
        
        # Add site info
        if show_site_badge:
            site = activity_data.get('site', 'Miruro') if not privacy_mode else 'Anime'
            parts.append(site)
        
        return " • ".join(parts) if parts else "Watching"

    def format_time(self, seconds):
        """Format seconds into MM:SS"""
        if not seconds or seconds < 0:
            return "0:00"
        
        mins = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{mins}:{secs:02d}"

    def clear_discord_activity(self):
        """Clear Discord Rich Presence activity"""
        if not self.is_connected or not self.rpc:
            return
        
        try:
            self.rpc.clear()
            self.current_activity = None
            logger.info("🧹 Cleared Discord activity")
            
        except Exception as e:
            logger.error(f"Failed to clear Discord activity: {e}")

    def run(self):
        """Run the Flask server blocking on main thread"""
        logger.info(f"🚀 Starting Enhanced Anime Rich Presence server on http://{self.host}:{self.port}")
        logger.info("💡 Make sure Discord is running!")
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
        """Clean up resources"""
        if self.rpc and self.is_connected:
            try:
                self.rpc.clear()
                self.rpc.close()
            except:
                pass
        logger.info("👋 Goodbye!")

def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(description="Enhanced Anime Rich Presence")
    parser.add_argument('--verbose', action='store_true', help='Enable verbose progress logging')
    args = parser.parse_args()

    print("🎌 Enhanced Anime Rich Presence")
    print("=" * 50)
    print("Features:")
    print("• Persistent green timestamp (never resets)")
    print("• Progress time display (02:30 / 24:00)")
    print("• Dynamic anime thumbnails from AniList (cached)")
    print("• Proper pause/play detection") 
    print("=" * 50)
    
    app = EnhancedAnimeRichPresence(verbose=args.verbose)
    
    try:
        app.run()
    except Exception as e:
        logger.error(f"Failed to start application: {e}")
        return 1
    
    return 0

if __name__ == "__main__":
    exit(main())
