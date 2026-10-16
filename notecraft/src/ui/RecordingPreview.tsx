// Insert › Record Video: what the camera sees while recording, with Stop.
import { useEffect, useRef } from "react";
import { useStore } from "../store/store.ts";
import { liveStream, stopRecording } from "../store/recorder.ts";

export function RecordingPreview() {
  const recording = useStore((s) => s.ui.recording);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (video.current && liveStream) video.current.srcObject = liveStream;
  }, [recording]);
  if (recording?.kind !== "video") return null;
  return (
    <div className="rec-preview" role="region" aria-label="Video recording">
      <video ref={video} autoPlay muted playsInline />
      <div className="rec-preview-bar">
        <i className="rec-dot" /> Recording
        <button className="btn" onClick={stopRecording}>Stop</button>
      </div>
    </div>
  );
}
