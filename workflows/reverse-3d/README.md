# Reverse 3D

Input: a finished video (3 to 18 seconds). Longer clips are trimmed to the first 18 seconds. Kling 4.0 Edit allows 3-30 seconds and keeps the input length; 18 seconds is the longest we send so a 24 fps re-wrap still stays inside that window.

Output: a blocky Blender-viewport playblast restyle via Kling 4.0 Edit. The side-by-side compare (original left, playblast right) is built in the browser so the graph does not OOM stitching frames. The first frame is dropped on both sides because Kling’s frame 0 is often smeared.

This workflow is playblast-only: LoadVideo → GetVideoComponents → ResizeAndPadImage → CreateVideo (constant 24 fps, original audio) → Kling4EditVideoNode → SaveVideo. Browser MediaRecorder WebMs often have no duration and confuse LoadVideo into reporting 1 fps; re-wrapping the decoded frames at 24 fps keeps the frame count and satisfies Kling’s 24 fps minimum without stitching (which OOMs).

Kling 4.0 Edit requires both sides between 700 and 4553 pixels and a width/height ratio from 0.40 to 2.50. Node 17 runs on every clip. The server sets its canvas from the file: MP4/MOV sample size, swapped when the track matrix is 90° or 270° so it matches the frames LoadVideo rotates, and WebM PixelWidth/PixelHeight even when the Segment size is the 8-byte unknown length Chrome MediaRecorder writes. It scales uniformly until both sides are at least 700, keeps an already-legal frame as-is up to 1920×1080, and pads with black only when the ratio is outside 0.40–2.50 (smallest legal canvas, 700×1750 or 1750×700). Nothing is cropped or stretched. The long side stays at or under 1920 so an 18 second 24 fps batch does not grow toward Kling’s 4553px ceiling.
