# Reverse 3D

Input: a finished video (3 to 18 seconds). Longer clips are trimmed to the first 18 seconds. Kling 4.0 Edit allows 3-30 seconds and keeps the input length; 18 seconds is the longest we send so a 24 fps re-wrap still stays inside that window.

Output: a blocky Blender-viewport playblast restyle via Kling 4.0 Edit. The side-by-side compare (original left, playblast right) is built in the browser so the graph does not OOM stitching frames. The first frame is dropped on both sides because Kling’s frame 0 is often smeared.

This workflow is playblast-only: LoadVideo → GetVideoComponents → CreateVideo (constant 24 fps) → Kling4EditVideoNode → SaveVideo. Browser MediaRecorder WebMs often have no duration and confuse LoadVideo into reporting 1 fps; re-wrapping the decoded frames at 24 fps keeps the frame count and satisfies Kling’s 24 fps minimum without stitching (which OOMs).
