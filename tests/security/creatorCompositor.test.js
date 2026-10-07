import assert from 'node:assert/strict';
import test from 'node:test';

import { CompositorError, MAX_CLIP_SECONDS, MAX_TOTAL_SECONDS, buildFfmpegArgs, buildRenderPlan } from '../../src/lib/creatorCompositor.js';
import { createEmptyTimeline } from '../../src/lib/creatorTimeline.js';

function timelineWithClips(clips, overrides = {}) {
    return { ...createEmptyTimeline(), clips, ...overrides };
}

function imageClip(overrides = {}) {
    return {
        id: 'clip-1',
        title: 'Opening shot',
        source: { url: 'https://cdn.muapi.ai/img1.png', type: 'image' },
        duration: 4,
        trim: { start: 0, end: null },
        transition: { type: 'cut' },
        ...overrides,
    };
}

test('buildRenderPlan rejects a timeline with no clips', () => {
    assert.throws(() => buildRenderPlan(createEmptyTimeline()), (error) => {
        assert.ok(error instanceof CompositorError);
        assert.equal(error.code, 'no_clips');
        return true;
    });
});

test('buildRenderPlan rejects a clip with no resolved media', () => {
    const timeline = timelineWithClips([imageClip({ source: null })]);
    assert.throws(() => buildRenderPlan(timeline), (error) => {
        assert.equal(error.code, 'unresolved_clip_source');
        return true;
    });
});

test('buildRenderPlan rejects an invalid caption', () => {
    const timeline = timelineWithClips([imageClip()], {
        captions: [{ start: 3, end: 1, text: 'backwards range' }],
    });
    assert.throws(() => buildRenderPlan(timeline), (error) => {
        assert.equal(error.code, 'invalid_caption');
        return true;
    });
});

test('buildRenderPlan sums clip durations and preserves requested transitions', () => {
    const timeline = timelineWithClips([
        imageClip({ duration: 4 }),
        imageClip({ id: 'clip-2', duration: 6, transition: { type: 'dissolve' } }),
    ]);
    const plan = buildRenderPlan(timeline);
    assert.equal(plan.clips.length, 2);
    assert.equal(plan.totalDuration, 10);
    assert.equal(plan.clips[1].requestedTransition, 'dissolve');
});

test('buildFfmpegArgs produces a single-clip, silent, captionless command', () => {
    const plan = buildRenderPlan(timelineWithClips([imageClip({ duration: 5 })]));
    const args = buildFfmpegArgs(plan, {
        clipFilePaths: ['/tmp/clip-1.png'],
        outputPath: '/tmp/out.mp4',
    });

    assert.deepEqual(
        args.slice(0, 10),
        ['-nostdin', '-y', '-protocol_whitelist', 'file', '-loop', '1', '-t', '5', '-i', '/tmp/clip-1.png'],
    );
    const filterIndex = args.indexOf('-filter_complex');
    assert.ok(filterIndex > -1);
    const filterComplex = args[filterIndex + 1];
    assert.match(filterComplex, /\[0:v]scale=1920:1080:force_original_aspect_ratio=decrease/);
    assert.match(filterComplex, /concat=n=1:v=1:a=0\[vcat]/);
    assert.deepEqual(args.slice(filterIndex + 2, filterIndex + 4), ['-map', '[vcat]']);
    assert.ok(args.includes('-an'), 'no voice/music track means -an, not a fabricated silent audio stream');
    assert.equal(args.at(-1), '/tmp/out.mp4');
});

test('buildFfmpegArgs chains concat across multiple clips in order', () => {
    const plan = buildRenderPlan(timelineWithClips([
        imageClip({ id: 'a', duration: 3 }),
        imageClip({ id: 'b', duration: 4, source: { url: 'https://cdn.muapi.ai/vid.mp4', type: 'video' } }),
        imageClip({ id: 'c', duration: 2 }),
    ]));
    const args = buildFfmpegArgs(plan, {
        clipFilePaths: ['/tmp/a.png', '/tmp/b.mp4', '/tmp/c.png'],
        outputPath: '/tmp/out.mp4',
    });
    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    assert.match(filterComplex, /\[v0]\[v1]\[v2]concat=n=3:v=1:a=0\[vcat]/);
    // The video clip (b, index 1) must NOT get -loop 1 -- only images loop.
    const iIndexes = args.reduce((acc, token, i) => (token === '-i' ? [...acc, i] : acc), []);
    assert.equal(iIndexes.length, 3);
    assert.equal(args[iIndexes[0] + 1], '/tmp/a.png');
    assert.equal(args[iIndexes[1] + 1], '/tmp/b.mp4');
    assert.equal(args[iIndexes[2] + 1], '/tmp/c.png');
    const clipBInputArgs = args.slice(iIndexes[0] + 2, iIndexes[1] + 1);
    assert.ok(!clipBInputArgs.includes('-loop'), 'video clip must not be treated as a looped still image');
});

test('buildFfmpegArgs rejects a clipFilePaths length mismatch', () => {
    const plan = buildRenderPlan(timelineWithClips([imageClip(), imageClip({ id: 'clip-2' })]));
    assert.throws(() => buildFfmpegArgs(plan, { clipFilePaths: ['/tmp/only-one.png'], outputPath: '/tmp/out.mp4' }), (error) => {
        assert.equal(error.code, 'clip_paths_mismatch');
        return true;
    });
});

test('buildFfmpegArgs burns in captions with timed enable windows', () => {
    const plan = buildRenderPlan(timelineWithClips([imageClip({ duration: 5 })], {
        captions: [{ start: 0.5, end: 2, text: "It's launch day" }],
    }));
    const args = buildFfmpegArgs(plan, { clipFilePaths: ['/tmp/a.png'], outputPath: '/tmp/out.mp4', fontFile: '/fonts/Inter.ttf' });
    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    assert.match(filterComplex, /drawtext=fontfile='\/fonts\/Inter\.ttf':expansion=none:text='It’s launch day':/);
    assert.match(filterComplex, /enable='between\(t,0\.5,2\)'\[vcap0]/);
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '[vcap0]']);
});

test('buildFfmpegArgs refuses captions without a caption font instead of failing inside ffmpeg', () => {
    const plan = buildRenderPlan(timelineWithClips([imageClip({ duration: 5 })], {
        captions: [{ start: 0.5, end: 2, text: 'Hello' }],
    }));
    assert.throws(
        () => buildFfmpegArgs(plan, { clipFilePaths: ['/tmp/a.png'], outputPath: '/tmp/out.mp4' }),
        (error) => error instanceof CompositorError && error.code === 'captions_font_missing',
    );
});

test('buildRenderPlan bounds an explicit resolution to even, capped dimensions', () => {
    const plan = buildRenderPlan(timelineWithClips([imageClip()], { aspectRatio: null, resolution: { width: 100_001, height: 721 } }));
    assert.deepEqual(plan.resolution, { width: 3840, height: 722 });
});

test('buildRenderPlan renders portrait and square storyboards at their own aspect ratio', () => {
    assert.deepEqual(buildRenderPlan(timelineWithClips([imageClip()], { aspectRatio: '9:16' })).resolution, { width: 1080, height: 1920 });
    assert.deepEqual(buildRenderPlan(timelineWithClips([imageClip()], { aspectRatio: '1:1' })).resolution, { width: 1080, height: 1080 });
    assert.deepEqual(buildRenderPlan(timelineWithClips([imageClip()])).resolution, { width: 1920, height: 1080 });
});

test('every ffmpeg input is restricted to local files so crafted media cannot fetch URLs', () => {
    const plan = buildRenderPlan(timelineWithClips([imageClip(), imageClip({ id: 'v', source: { url: 'https://cdn.muapi.ai/v.mp4', type: 'video' } })], {
        voiceTrack: { url: 'https://cdn.muapi.ai/v.m4a' },
    }));
    const args = buildFfmpegArgs(plan, { clipFilePaths: ['/tmp/a', '/tmp/b'], voiceFilePath: '/tmp/v', outputPath: '/tmp/o.mp4' });
    const inputs = args.reduce((count, arg) => count + (arg === '-i' ? 1 : 0), 0);
    const whitelists = args.reduce((count, arg, index) => count + (arg === '-protocol_whitelist' && args[index + 1] === 'file' ? 1 : 0), 0);
    assert.equal(inputs, 3);
    assert.equal(whitelists, inputs);
    assert.equal(args[0], '-nostdin');
});

test('buildFfmpegArgs mixes voice and music with music ducked, and maps both', () => {
    const plan = buildRenderPlan(timelineWithClips([imageClip()], {
        voiceTrack: { url: 'https://cdn.muapi.ai/voice.mp3' },
        musicTrack: { url: 'https://cdn.muapi.ai/music.mp3' },
    }));
    const args = buildFfmpegArgs(plan, {
        clipFilePaths: ['/tmp/a.png'],
        voiceFilePath: '/tmp/voice.mp3',
        musicFilePath: '/tmp/music.mp3',
        outputPath: '/tmp/out.mp4',
    });
    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    assert.match(filterComplex, /\[1:a]volume=1\.0\[va]/);
    assert.match(filterComplex, /\[2:a]volume=0\.25\[ma]/);
    assert.match(filterComplex, /\[va]\[ma]amix=inputs=2:duration=first:dropout_transition=2\[aout]/);
    assert.ok(args.includes('-an') === false);
    const mapIndexes = args.reduce((acc, token, i) => (token === '-map' ? [...acc, args[i + 1]] : acc), []);
    assert.deepEqual(mapIndexes, ['[vcat]', '[aout]']);
});

test('buildFfmpegArgs with only a music track still produces audio, ducked', () => {
    const plan = buildRenderPlan(timelineWithClips([imageClip()], {
        musicTrack: { url: 'https://cdn.muapi.ai/music.mp3' },
    }));
    const args = buildFfmpegArgs(plan, {
        clipFilePaths: ['/tmp/a.png'],
        musicFilePath: '/tmp/music.mp3',
        outputPath: '/tmp/out.mp4',
    });
    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    assert.match(filterComplex, /\[1:a]volume=0\.25\[aout]/);
});

test('buildRenderPlan rejects a clip or timeline longer than the bounds', () => {
    assert.throws(() => buildRenderPlan(timelineWithClips([imageClip({ duration: MAX_CLIP_SECONDS + 1 })])), (error) => {
        assert.equal(error.code, 'clip_too_long');
        return true;
    });
    const clipCount = Math.ceil(MAX_TOTAL_SECONDS / MAX_CLIP_SECONDS) + 1;
    const clips = Array.from({ length: clipCount }, (_, index) => imageClip({ id: `clip-${index}`, duration: MAX_CLIP_SECONDS }));
    assert.throws(() => buildRenderPlan(timelineWithClips(clips)), (error) => {
        assert.equal(error.code, 'timeline_too_long');
        return true;
    });
    assert.doesNotThrow(() => buildRenderPlan(timelineWithClips([imageClip({ duration: MAX_CLIP_SECONDS })])));
});
