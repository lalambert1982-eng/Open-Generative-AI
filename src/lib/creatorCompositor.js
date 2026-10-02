// Creator Studio Compositor -- turns a validated `creator.timeline.v1`
// manifest (see creatorTimeline.js) into an ffmpeg command that produces a
// real MP4. This module is deliberately split into pure, side-effect-free
// functions (buildRenderPlan / buildFfmpegArgs) so the command-construction
// logic -- the part most likely to have a subtle bug -- can be unit tested
// without spawning ffmpeg or touching the network/filesystem. The actual
// process-spawning/upload wiring lives in creatorProjectStore.js's
// `renderCreatorTimeline`, which is NOT exercised by this module's tests
// (no ffmpeg binary/network available in every environment this repo runs
// in -- see docs/CREATOR_STUDIO_OS.md's Built/Configured/Tested convention;
// this module's functions are TESTED, the end-to-end render is BUILT, not
// yet live-verified).
//
// V1 scope, deliberately bounded (see "Known gaps" at the bottom):
// - Clips are concatenated as silent video (voice/music are separate
//   tracks in the timeline schema -- clips never carry their own audio in
//   this build phase).
// - Every transition renders as a hard cut. `dissolve`/`fade`/`dip-black`/
//   `match`/`whip` are accepted by the timeline schema but not yet
//   implemented as real crossfades here -- see "Known gaps".
// - Captions burn in as plain drawtext overlays, timed to each cue.
// - Voice + music mix via a simple two-track amix with music ducked to a
//   fixed volume -- no sidechain compression.

export class CompositorError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CompositorError';
        this.code = code;
    }
}

const DEFAULT_FPS = 30;
const MUSIC_DUCK_VOLUME = 0.25;
const MAX_CAPTIONS_RENDERED = 200;
const MIN_DIMENSION = 64;
const MAX_DIMENSION = 3840;

// drawtext runs with expansion=none, so % is literal; only the option-level
// escapes remain. A straight quote becomes U+2019 because escaping it inside a
// single-quoted filter argument needs the fragile '\'' sequence.
function escapeDrawtext(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/'/g, '’');
}

// libx264/yuv420p needs even dimensions; the cap bounds render cost.
function evenDimension(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.round(parsed / 2) * 2));
}

function clipInputLabel(index) {
    return `v${index}`;
}

export function buildRenderPlan(timeline) {
    if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) {
        throw new CompositorError('invalid_timeline', 'A timeline manifest is required.');
    }
    const clips = Array.isArray(timeline.clips) ? timeline.clips : [];
    if (clips.length === 0) {
        throw new CompositorError('no_clips', 'The timeline has no clips to render.');
    }
    const resolvedClips = clips.map((clip, index) => {
        const url = clip?.source?.url;
        if (typeof url !== 'string' || !url) {
            throw new CompositorError(
                'unresolved_clip_source',
                `Clip ${index + 1} ("${clip?.title || 'untitled'}") has no generated image/video yet -- ` +
                    'generate or attach media for every scene before rendering.',
            );
        }
        return {
            id: clip.id || `clip-${index + 1}`,
            title: clip.title || `Scene ${index + 1}`,
            sourceUrl: url,
            sourceType: clip.source.type === 'video' ? 'video' : 'image',
            duration: Number.isFinite(Number(clip.duration)) && Number(clip.duration) > 0 ? Number(clip.duration) : 5,
            trimStart: Number.isFinite(Number(clip?.trim?.start)) ? Math.max(0, Number(clip.trim.start)) : 0,
            // V1: every transition renders as a cut -- see module docstring
            // "Known gaps". Recorded here (not silently dropped) so a
            // future version can tell "requested dissolve, rendered as
            // cut" from "requested cut".
            requestedTransition: clip?.transition?.type || 'cut',
        };
    });

    const captions = (Array.isArray(timeline.captions) ? timeline.captions : [])
        .slice(0, MAX_CAPTIONS_RENDERED)
        .map((caption, index) => {
            const start = Number(caption?.start);
            const end = Number(caption?.end);
            const text = typeof caption?.text === 'string' ? caption.text.trim() : '';
            if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
                throw new CompositorError('invalid_caption', `Caption ${index + 1} must have text and a valid start/end range.`);
            }
            return { start, end, text };
        });

    const voiceTrack = timeline.voiceTrack && typeof timeline.voiceTrack.url === 'string' && timeline.voiceTrack.url
        ? { url: timeline.voiceTrack.url }
        : null;
    const musicTrack = timeline.musicTrack && typeof timeline.musicTrack.url === 'string' && timeline.musicTrack.url
        ? { url: timeline.musicTrack.url }
        : null;

    const resolution = {
        width: evenDimension(timeline?.resolution?.width, 1920),
        height: evenDimension(timeline?.resolution?.height, 1080),
    };

    return Object.freeze({
        clips: Object.freeze(resolvedClips),
        captions: Object.freeze(captions),
        voiceTrack,
        musicTrack,
        resolution,
        totalDuration: resolvedClips.reduce((sum, clip) => sum + clip.duration, 0),
    });
}

// `filePaths` must be an array of local file paths, one per plan.clips
// entry, in the same order -- downloading plan.clips[i].sourceUrl to that
// path is the caller's job (creatorProjectStore.js's renderCreatorTimeline),
// kept out of this function so it stays a pure, synchronous, testable
// mapping from (plan, local paths) -> ffmpeg argv.
// Static ffmpeg builds ship without fontconfig, so drawtext needs an explicit
// font file whenever the plan has captions.
export function buildFfmpegArgs(plan, { clipFilePaths, voiceFilePath = null, musicFilePath = null, outputPath, fontFile = null }) {
    if (!Array.isArray(clipFilePaths) || clipFilePaths.length !== plan.clips.length) {
        throw new CompositorError('clip_paths_mismatch', 'clipFilePaths must have exactly one local path per plan clip.');
    }
    if (!outputPath) throw new CompositorError('missing_output_path', 'An outputPath is required.');
    if (plan.captions.length > 0 && !fontFile) {
        throw new CompositorError('captions_font_missing', 'Captions need a server caption font (CREATOR_RENDER_FONT_FILE).');
    }

    const args = ['-y'];
    const inputArgs = [];
    plan.clips.forEach((clip, index) => {
        if (clip.sourceType === 'image') {
            inputArgs.push('-loop', '1', '-t', String(clip.duration), '-i', clipFilePaths[index]);
        } else {
            if (clip.trimStart > 0) inputArgs.push('-ss', String(clip.trimStart));
            inputArgs.push('-t', String(clip.duration), '-i', clipFilePaths[index]);
        }
    });
    let audioInputCount = 0;
    let voiceInputIndex = null;
    let musicInputIndex = null;
    if (voiceFilePath) {
        voiceInputIndex = plan.clips.length + audioInputCount;
        inputArgs.push('-i', voiceFilePath);
        audioInputCount += 1;
    }
    if (musicFilePath) {
        musicInputIndex = plan.clips.length + audioInputCount;
        inputArgs.push('-i', musicFilePath);
        audioInputCount += 1;
    }
    args.push(...inputArgs);

    const { width, height } = plan.resolution;
    const filters = [];

    plan.clips.forEach((_clip, index) => {
        filters.push(
            `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
                `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${DEFAULT_FPS}[${clipInputLabel(index)}]`,
        );
    });
    const concatInputs = plan.clips.map((_clip, index) => `[${clipInputLabel(index)}]`).join('');
    filters.push(`${concatInputs}concat=n=${plan.clips.length}:v=1:a=0[vcat]`);

    let videoLabel = 'vcat';
    plan.captions.forEach((caption, index) => {
        const nextLabel = `vcap${index}`;
        filters.push(
            `[${videoLabel}]drawtext=fontfile='${escapeDrawtext(fontFile)}':expansion=none:text='${escapeDrawtext(caption.text)}':` +
                "fontcolor=white:fontsize=48:box=1:boxcolor=black@0.55:boxborderw=12:" +
                "x=(w-text_w)/2:y=h-th-80:" +
                `enable='between(t,${caption.start},${caption.end})'[${nextLabel}]`,
        );
        videoLabel = nextLabel;
    });

    let audioLabel = null;
    if (voiceInputIndex != null && musicInputIndex != null) {
        filters.push(`[${voiceInputIndex}:a]volume=1.0[va]`);
        filters.push(`[${musicInputIndex}:a]volume=${MUSIC_DUCK_VOLUME}[ma]`);
        filters.push('[va][ma]amix=inputs=2:duration=first:dropout_transition=2[aout]');
        audioLabel = 'aout';
    } else if (voiceInputIndex != null) {
        filters.push(`[${voiceInputIndex}:a]volume=1.0[aout]`);
        audioLabel = 'aout';
    } else if (musicInputIndex != null) {
        filters.push(`[${musicInputIndex}:a]volume=${MUSIC_DUCK_VOLUME}[aout]`);
        audioLabel = 'aout';
    }

    args.push('-filter_complex', filters.join(';'));
    args.push('-map', `[${videoLabel}]`);
    if (audioLabel) {
        args.push('-map', `[${audioLabel}]`);
    } else {
        args.push('-an');
    }
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
    if (audioLabel) args.push('-c:a', 'aac', '-b:a', '160k');
    args.push('-shortest', '-movflags', '+faststart', outputPath);

    return args;
}

// Known gaps (deliberate v1 scope boundaries, not oversights):
// - No real crossfade/dissolve transitions -- xfade/acrossfade filter-graph
//   timing (cumulative-offset math across N clips) is real, fiddly work
//   that deserves its own focused pass with a way to actually verify
//   output, not a blind addition. Every transition renders as a cut for
//   now; `requestedTransition` is preserved on the plan so a future pass
//   can tell "wanted dissolve, got cut" from "wanted cut".
// - No Ken Burns / pan-zoom on still images.
// - No per-clip audio (clips are always silent B-roll in this schema;
//   voice/music are the only audio sources).
// - Captions are burned in as plain text, not styled/positioned per-cue.
