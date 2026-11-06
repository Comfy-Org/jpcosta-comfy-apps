# Reverse 3D

Input: a finished video (max 18 seconds).

Output: a blocky Blender-viewport playblast restyle via Kling 4.0 Edit. The side-by-side compare (original left, playblast right) is built in the browser so the graph does not OOM stitching frames. The first frame is dropped on both sides because Kling’s frame 0 is often smeared.

This workflow is playblast-only: LoadVideo → Kling4EditVideoNode → SaveVideo.
