import { useState, useEffect } from "react";

type ToastType = "success" | "error" | "info";

export function Toast({
  message,
  type = "info",
  onClose,
}: {
  message: string;
  type?: ToastType;
  onClose: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const colors: Record<ToastType, string> = {
    success: "bg-emerald-950/80 border-emerald-700 text-emerald-200",
    error: "bg-red-950/80 border-red-700 text-red-200",
    info: "bg-zinc-800/80 border-zinc-600 text-zinc-200",
  };

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 px-4 py-3 border rounded-lg shadow-lg backdrop-blur ${colors[type]}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm">{message}</span>
        <button
          onClick={onClose}
          className="text-zinc-400 hover:text-zinc-200 ml-2"
        >
          &times;
        </button>
      </div>
    </div>
  );
}

export function useToast() {
  const [toast, setToast] = useState<{
    message: string;
    type: ToastType;
  } | null>(null);

  const show = (message: string, type: ToastType = "info") => {
    setToast({ message, type });
  };

  const hide = () => setToast(null);

  return { toast, show, hide };
}
