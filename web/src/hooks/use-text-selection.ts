import { useEffect, useState } from "react";

export function useTextSelection(rootSelector: string) {
  const [selectedText, setSelectedText] = useState("");

  useEffect(() => {
    const onSelectionChange = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || "";
      if (!selection || !text) {
        setSelectedText("");
        return;
      }
      const anchor = selection.anchorNode?.parentElement;
      if (anchor?.closest(rootSelector)) setSelectedText(text);
    };

    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [rootSelector]);

  return selectedText;
}
