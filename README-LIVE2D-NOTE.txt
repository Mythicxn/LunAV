LIVE2D NOTES
=============
- Mouse tracking now writes directly to ParamAngleX/Y and ParamEyeBallX/Y.
- Head movement is intentionally small (about +/-10 degrees X, +/-7 degrees Y).
- Eye movement is separate and stronger than head movement.
- Tracking is smoothed and has a small dead-zone.
- Strawberry Rabbit Param261 (watermark) is forced to 0 when loaded.
- Vanilla is an upper-body/bust model in the supplied Live2D asset; the source
  model does not contain a full lower body. The app cannot reveal body parts
  that are not present in the model.
- Zoom/pan changes do not change the mouse-to-head coordinate mapping.
