import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

export function getSelectionInRoot(rootSelector: string) {
  const selection = window.getSelection();
  const text = selection?.toString().trim() || "";
  const root = document.querySelector(rootSelector);
  if (!selection || !text || !root) return "";

  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if (!anchor || !focus) return "";
  return root.contains(anchor) && root.contains(focus) ? text : "";
}

export function useTextSelection(rootSelector: string) {
  const [selectedText, setSelectedText] = useState("");
  const lastSelectedText = useRef("");

  const commitSelection = useCallback((text: string, sync = false) => {
    if (!text || text === lastSelectedText.current) return;
    lastSelectedText.current = text;
    if (sync) {
      flushSync(() => setSelectedText(text));
      return;
    }
    setSelectedText(text);
  }, []);

  const clearSelection = useCallback(() => {
    lastSelectedText.current = "";
    flushSync(() => setSelectedText(""));
  }, []);

  const captureSelection = useCallback(() => {
    const text = getSelectionInRoot(rootSelector);
    if (text) commitSelection(text, true);
    return text || lastSelectedText.current;
  }, [commitSelection, rootSelector]);

  const getCachedSelection = useCallback(() => lastSelectedText.current, []);

  useEffect(() => {
    const onSelectionChange = () => {
      const text = getSelectionInRoot(rootSelector);
      if (text) commitSelection(text);
    };

    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [commitSelection, rootSelector]);

  return { selectedText, captureSelection, clearSelection, getCachedSelection };
}
