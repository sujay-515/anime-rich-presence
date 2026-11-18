#!/usr/bin/env python3
"""
Enhanced Anime Rich Presence - Python Desktop App
Persistent timestamp, includes progress time display
"""

import time
import threading
import json
import requests
import hashlib
from datetime import datetime, timezone
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
    def __init__(self):
        self.client_id = "1421704557830078464"
        self.rpc = None
        self.is_connected = False
        self.current_activity = None
        self.session_start_time = int(time.time())  # Fixed session start time
        self.flask_app = Flask(__name__)
        CORS(self.flask_app, origins=[
            "https://miruro.tv",
            "https://miruro.to",
            "https://www.miruro.to",
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
                'timestamp': datetime.now().isoformat()
            })
        
        @self.flask_app.route('/update', methods=['POST'])
        def update_activity():
            try:
                data = request.get_json()
                logger.info(f"RECEIVED DATA: {json.dumps(data, indent=2)}")
                if not data:
                    return jsonify({'success': False, 'error': 'No data provided'}), 400
                
                self.update_discord_activity(data)
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
    
    def connect_to_discord(self):
        """Connect to Discord RPC"""
        try:
            logger.info("🔗 Connecting to Discord...")
            self.rpc = Presence(self.client_id)
            self.rpc.connect()
            self.is_connected = True
            logger.info("✅ Connected to Discord!")
            
        except Exception as e:
            logger.error(f"❌ Failed to connect to Discord: {e}")
            logger.info("🔄 Will retry in 10 seconds...")
            threading.Timer(10.0, self.connect_to_discord).start()
    
    def get_anime_thumbnail(self, anime_title):
        """Fetch anime thumbnail from AniList API"""
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
            
            variables = {'search': anime_title}
            
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
                        return cover_url
                        
        except Exception as e:
            logger.warning(f"Failed to fetch thumbnail for {anime_title}: {e}")
        
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
                'state': self.format_episode_state(activity_data, is_paused or not is_playing),
                'large_image': 'anime_large',
                'large_text': title,
                'small_image': small_image,
                'small_text': small_text,
                'start': self.session_start_time  # Persistent timestamp that never resets
            }
            
            # Try to get anime thumbnail
            thumbnail_url = self.get_anime_thumbnail(title)
            if thumbnail_url:
                discord_activity['large_image'] = thumbnail_url
                discord_activity['large_text'] = title
            
            # Remove None values
            discord_activity = {k: v for k, v in discord_activity.items() if v is not None}
            
            self.rpc.update(**discord_activity)
            self.current_activity = discord_activity
            
            logger.info(f"📺 Updated Discord activity: {title} - {playing_status}")
            
        except Exception as e:
            logger.error(f"Failed to update Discord activity: {e}")
            if "RPC connection not found" in str(e):
                self.is_connected = False
                self.connect_to_discord()
            raise
    
    def format_episode_state(self, activity_data, is_paused_state):
        """Format episode and progress information with time display"""
        parts = []
        
        # Add pause status if paused
        if is_paused_state:
            parts.append("Paused")
        
        # Add episode info
        if activity_data.get('episode'):
            parts.append(f"Episode {activity_data['episode']}")
        
        # Add progress time display
        if activity_data.get('progress') and activity_data.get('duration'):
            progress_time = self.format_time(activity_data['progress'])
            duration_time = self.format_time(activity_data['duration'])
            progress_percent = min(100, max(0, int((activity_data['progress'] / activity_data['duration']) * 100)))
            parts.append(f"{progress_time} / {duration_time} ({progress_percent}%)")
        
        # Add site info
        site = activity_data.get('site', 'Miruro')
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
    
    def run(self, host='localhost', port=3000):
        """Run the Flask server"""
        logger.info(f"🚀 Starting Enhanced Anime Rich Presence server on http://{host}:{port}")
        logger.info("💡 Make sure Discord is running!")
        logger.info("🔌 Features: Persistent timestamp, progress time display, dynamic thumbnails!")
        
        try:
            self.flask_app.run(
                host=host, 
                port=port, 
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
    print("🎌 Enhanced Anime Rich Presence")
    print("=" * 50)
    print("Features:")
    print("• Persistent green timestamp (never resets)")
    print("• Progress time display (02:30 / 24:00)")
    print("• Dynamic anime thumbnails from AniList")
    print("• Proper pause/play detection") 
    print("=" * 50)
    
    app = EnhancedAnimeRichPresence()
    
    try:
        app.run()
    except Exception as e:
        logger.error(f"Failed to start application: {e}")
        return 1
    
    return 0

if __name__ == "__main__":
    exit(main())
