# Changelog

## 3.0.0
- Each element is its own instrument, with four controls of its own; every channel keeps separate settings per element.
- Map without a centre: move nodes, link, cut, scroll over a link to change its strength. Distance sets delay, pan and connection strength.
- Shapes (spiral, ring, grid, clusters, river, scatter), RESHAPE for a completely new body, FREEZE LINKS.
- SEED: random presets with seven generated nature sounds. Every load starts from a new seed.
- Dynamics (swells and rests) and Mutation (the system rewrites its own settings, and channels can change element).
- The original 6-second convolution reverb is back.
- Store player: big waveform, playhead, click/drag to seek, ±5 s skip, K/J/L keys.
- File export: SAVE WAV per take, SAVE SOUND per channel, EXPORT ALL as a zip with a manifest.
- Engine split into a channel processor and a master processor. Offline stress test included.

## 2.0.0
- New AudioWorklet engine with stability guarantees (no loops between channels, feedback held below unity, limiter, NaN reset).
- Redesigned interface: select a channel to edit it, plain-language help bar.

## 1.0.0
- First version: 8 connected channels, elements, recorder.
