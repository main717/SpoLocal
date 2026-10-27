/*
 * Playlist page session entry point.
 * Initializes the session controller and enables column resizing.
 */
import { PlaylistSessionController } from './playlist/session.js?v=143';
import { PlaylistColumnResizer } from './ui/column_resizer.js';
import { PlaylistPlayerState } from './player/player_state.js';
import { MseStreamController } from './player/mse_stream_controller.js?v=8';

const hub = (typeof window !== 'undefined' ? (window.SpolocalPlayerHub = window.SpolocalPlayerHub || {}) : {});
hub.streamBadgeEl = document.getElementById('player-stream-badge');
const state = new PlaylistPlayerState(hub);
const session = new PlaylistSessionController(state);
session.bootstrap();
const mse = new MseStreamController();
window.SpolocalMse = mse;
// Expose transport methods through hub for global access
hub.resolveCurrentPlaySrc = () => session.transport.resolveCurrentPlaySrc();
hub.setPlayUi = (playing) => session.transport.setPlayUi(playing);
hub.playLibraryEntry = (entry, context) => session.transport.playLibraryEntry(entry, context);
hub.applyStreamLoudness = (vid) => session.quality.apply_stream_loudness(vid);
hub.prefetchNextLoudness = () => session.transport.prefetch_next_loudness();
hub.onMseStreamEnded = () => session.transport.advance_search_stream();
PlaylistColumnResizer.init();
