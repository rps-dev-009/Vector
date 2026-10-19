import { useEffect, useRef, useState } from "react";
import { IMAGE_LIMITS, prepareImage } from "../imageAttachments.js";

export function useLabsImages() {
  const [images, setImages] = useState([]);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const add = async files => {
    if (busy.current) return;
    const selected = Array.from(files || []);
    if (!selected.length) return;
    const available = IMAGE_LIMITS.maxCount - images.length;
    if (selected.length > available) { setError(`Attach up to ${IMAGE_LIMITS.maxCount} images at a time. Remove one before adding more.`); return; }
    busy.current = true; setPreparing(true); setError("");
    const ready = [];
    const errors = [];
    try {
      for (const file of selected) {
        try { ready.push(await prepareImage(file)); }
        catch (err) { errors.push(`${file.name || "Image"}: ${err.message}`); }
        if (!alive.current) return;
      }
      setImages(previous => [...previous, ...ready]);
      if (errors.length) setError(errors.join(" "));
    } finally {
      busy.current = false;
      if (alive.current) setPreparing(false);
    }
  };
  return {
    images, preparing, error, add,
    remove: id => setImages(previous => previous.filter(image => image.id !== id)),
    clear: () => { setImages([]); setError(""); },
    restore: saved => { if (alive.current) setImages(saved); }
  };
}
