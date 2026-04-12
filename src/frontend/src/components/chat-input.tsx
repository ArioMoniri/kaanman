"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { ArrowUp, Square, Mic, MicOff, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { VoiceMorph } from "@/components/ui/voice-morph";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

const cn = (...classes: (string | undefined | null | false)[]) =>
  classes.filter(Boolean).join(" ");

/* ---------- Tooltip ---------- */
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "z-50 overflow-hidden rounded-md border border-[#333333] bg-[#1F2023] px-3 py-1.5 text-sm text-white shadow-md",
      "animate-in fade-in-0 zoom-in-95",
      className
    )}
    {...props}
  />
));
TooltipContent.displayName = "TooltipContent";

/* ---------- Voice Input Hook (dual mode: Web Speech API + MediaRecorder fallback) ---------- */

type VoiceMode = "idle" | "web-speech" | "recorder" | "transcribing";

function useVoiceInput(onTranscript: (text: string) => void) {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [interim, setInterim] = useState("");
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<VoiceMode>("idle");
  const [audioLevel, setAudioLevel] = useState(0);

  // Refs
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const wantListeningRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Once Web Speech API fails with "network", permanently switch to recorder mode
  const webSpeechBrokenRef = useRef(false);
  // Whether the backend transcription endpoint is available
  const backendAvailableRef = useRef<boolean | null>(null);
  // Audio analyser for volume metering
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioRafRef = useRef<number>(0);

  // ── Check support on mount ──
  useEffect(() => {
    const hasSR =
      "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
    const hasRecorder = typeof MediaRecorder !== "undefined";
    const hasMic = !!navigator.mediaDevices?.getUserMedia;

    // Check backend transcription availability
    fetch(`${API_URL}/api/transcribe/check`)
      .then((r) => r.json())
      .then((data) => {
        backendAvailableRef.current = !!data.available;
        // If backend available OR Web Speech API available → supported
        setIsSupported(data.available || hasSR);
        if (data.available) {
          console.log("[Voice] Backend transcription available via", data.provider);
        }
      })
      .catch(() => {
        backendAvailableRef.current = false;
        setIsSupported(hasSR);
      });

    // If no microphone API at all, not supported
    if (!hasMic && !hasSR) {
      setIsSupported(false);
    }
  }, []);

  // ── Audio level metering ──
  const startAudioMeter = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length / 255;
        setAudioLevel(Math.min(1, avg * 2.5));
        audioRafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* audio context not available */ }
  }, []);

  const stopAudioMeter = useCallback(() => {
    if (audioRafRef.current) {
      cancelAnimationFrame(audioRafRef.current);
      audioRafRef.current = 0;
    }
    analyserRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setAudioLevel(0);
  }, []);

  // ── Web Speech API start ──
  const startWebSpeech = useCallback(() => {
    if (recognitionRef.current) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    wantListeningRef.current = true;
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    // Don't force a language — let the browser auto-detect the spoken language.
    // This enables Turkish, English, Arabic, etc. without user configuration.
    // If the browser's speech engine struggles, the MediaRecorder → Whisper
    // fallback provides excellent multilingual auto-detection.

    let finalTranscript = "";

    recognition.addEventListener("start", () => {
      setIsListening(true);
      setMode("web-speech");
      setError(null);
      // Get mic stream for audio level metering (visual only)
      navigator.mediaDevices?.getUserMedia({ audio: true }).then((stream) => {
        streamRef.current = stream;
        startAudioMeter(stream);
      }).catch(() => { /* meter not critical */ });
    });

    recognition.addEventListener("result", (event) => {
      const e = event as SpeechRecognitionEvent;
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          finalTranscript += transcript + " ";
        } else {
          interimText += transcript;
        }
      }
      setInterim(interimText);
      if (finalTranscript.trim()) {
        onTranscript(finalTranscript.trim());
        finalTranscript = "";
      }
    });

    recognition.addEventListener("error", (event) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errCode = (event as any).error as string | undefined;
      if (errCode === "aborted" || errCode === "no-speech") return;

      if (errCode === "network") {
        console.warn("[Voice] Web Speech API network error — switching to recorder mode");
        webSpeechBrokenRef.current = true;
        wantListeningRef.current = false;
        recognitionRef.current = null;
        setIsListening(false);
        setInterim("");
        setMode("idle");
        // Auto-switch: start recorder if backend is available
        if (backendAvailableRef.current) {
          // Small delay to let cleanup finish
          setTimeout(() => startRecorder(), 100);
        } else {
          setError("Voice transcription unavailable — set GROQ_API_KEY on the server");
        }
        return;
      }

      if (errCode === "not-allowed" || errCode === "service-not-allowed") {
        setError("Microphone access denied — check browser permissions");
      } else {
        setError(`Voice error: ${errCode}`);
      }
      wantListeningRef.current = false;
      recognitionRef.current = null;
      setIsListening(false);
      setInterim("");
      setMode("idle");
    });

    recognition.addEventListener("end", () => {
      if (wantListeningRef.current && !webSpeechBrokenRef.current) {
        try {
          recognition.start();
          return;
        } catch { /* give up */ }
      }
      recognitionRef.current = null;
      setIsListening(false);
      setInterim("");
      setMode("idle");
    });

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      wantListeningRef.current = false;
      recognitionRef.current = null;
    }
  }, [onTranscript, startAudioMeter]);

  // ── MediaRecorder start (fallback) ──
  const startRecorder = useCallback(async () => {
    if (mediaRecorderRef.current) return;
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Pick a supported mime type
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/ogg";

      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Stop mic stream
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        mediaRecorderRef.current = null;

        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];

        if (blob.size < 100) {
          setIsListening(false);
          setMode("idle");
          return;
        }

        // Send to backend for transcription
        setIsTranscribing(true);
        setMode("transcribing");
        setInterim("Transcribing...");

        try {
          // Don't force language — let Whisper auto-detect the spoken language
          const form = new FormData();
          const ext = mimeType.includes("webm") ? "webm" : "ogg";
          form.append("file", blob, `recording.${ext}`);

          const resp = await fetch(`${API_URL}/api/transcribe`, {
            method: "POST",
            body: form,
          });

          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(errData.detail || `HTTP ${resp.status}`);
          }

          const data = await resp.json();
          if (data.text && data.text.trim()) {
            // Normalize protocol numbers: spoken digits may come as words or
            // separated groups ("70 21 48 97", "yetmiş iki on dört...").
            // Strip spaces/dashes between digit groups to form a single protocol ID.
            let text = data.text.trim();
            // Collapse digit groups separated only by spaces/dashes into one number
            // e.g., "70 21 48 97" → "70214897", "70-21-48-97" → "70214897"
            text = text.replace(/(\d)\s*[-–—]\s*(\d)/g, "$1$2");
            // Collapse sequences of space-separated 2-3 digit groups
            text = text.replace(/\b(\d{2,3})\s+(?=\d{2,3}\b)/g, "$1");
            onTranscript(text);
          }
        } catch (e) {
          console.error("[Voice] Transcription failed:", e);
          setError(`Transcription failed: ${e instanceof Error ? e.message : "Unknown error"}`);
        } finally {
          setIsTranscribing(false);
          setIsListening(false);
          setInterim("");
          setMode("idle");
        }
      };

      recorder.onerror = () => {
        setError("Recording failed");
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        mediaRecorderRef.current = null;
        setIsListening(false);
        setMode("idle");
      };

      mediaRecorderRef.current = recorder;
      recorder.start(1000); // collect data every 1s
      setIsListening(true);
      setMode("recorder");
      setInterim("Recording... click mic to stop");
      startAudioMeter(stream);
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotAllowedError") {
        setError("Microphone access denied — check browser permissions");
      } else {
        setError(`Could not access microphone: ${e instanceof Error ? e.message : "Unknown"}`);
      }
    }
  }, [onTranscript, startAudioMeter]);

  // ── Stop ──
  const stop = useCallback(() => {
    wantListeningRef.current = false;
    stopAudioMeter();

    // Stop Web Speech API
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      try { rec.stop(); } catch { /* ignore */ }
    }

    // Stop MediaRecorder (triggers onstop → transcription)
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      try { mr.stop(); } catch { /* ignore */ }
      // Don't clear isListening here — onstop handler will after transcription
      return;
    }

    // Stop raw stream if lingering
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    setIsListening(false);
    setInterim("");
    setMode("idle");
  }, [stopAudioMeter]);

  // ── Toggle ──
  const toggle = useCallback(() => {
    if (isListening || isTranscribing) {
      stop();
      return;
    }

    setError(null);

    // If Web Speech API previously failed with network, go straight to recorder
    if (webSpeechBrokenRef.current) {
      if (backendAvailableRef.current) {
        startRecorder();
      } else {
        setError("Voice transcription unavailable — set GROQ_API_KEY on the server");
      }
      return;
    }

    // Prefer Whisper (recorder mode) for multilingual auto-detection.
    // Web Speech API is only used as fallback when backend is unavailable.
    const hasSR =
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
    if (backendAvailableRef.current) {
      // Whisper supports 100+ languages with auto-detection
      startRecorder();
    } else if (hasSR) {
      startWebSpeech();
    } else {
      setError("Voice input not available in this browser");
    }
  }, [isListening, isTranscribing, stop, startWebSpeech, startRecorder]);

  const clearError = useCallback(() => setError(null), []);

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      stopAudioMeter();
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      if (rec) {
        try { rec.stop(); } catch { /* ignore */ }
      }
      const mr = mediaRecorderRef.current;
      mediaRecorderRef.current = null;
      if (mr && mr.state !== "inactive") {
        try { mr.stop(); } catch { /* ignore */ }
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [stopAudioMeter]);

  return {
    isListening,
    isTranscribing,
    interim,
    isSupported,
    error,
    mode,
    audioLevel,
    toggle,
    stop,
    clearError,
  };
}

/* ---------- ChatInput ---------- */
interface ChatInputProps {
  onSend: (message: string) => void;
  onCancel?: () => void;
  isLoading?: boolean;
  placeholder?: string;
}

export function ChatInput({
  onSend,
  onCancel,
  isLoading = false,
  placeholder = "Ask a clinical question...",
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const maxHeight = 128;

  const handleVoiceTranscript = useCallback((text: string) => {
    setValue((prev) => (prev ? prev + " " + text : text));
  }, []);

  const voice = useVoiceInput(handleVoiceTranscript);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const h = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${h}px`;
    el.style.overflowY = h >= maxHeight ? "auto" : "hidden";
  }, [value, maxHeight]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    voice.stop();
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const hasContent = value.trim().length > 0;

  return (
    <TooltipProvider>
      {/* Voice error banner */}
      {voice.error && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 px-3 py-2 text-sm text-red-300">
          <span className="flex-1">{voice.error}</span>
          <button
            onClick={voice.clearError}
            className="shrink-0 text-red-400 hover:text-red-200 transition-colors text-xs font-medium"
          >
            Dismiss
          </button>
        </div>
      )}
      {/* Voice morph animation — shown above input when listening */}
      {voice.isListening && (
        <div className="flex justify-center mb-2">
          <button
            onClick={voice.toggle}
            className="cursor-pointer focus:outline-none"
            title="Click to stop recording"
          >
            <VoiceMorph
              audioLevel={voice.audioLevel}
              isActive={voice.isListening}
              className="w-48 h-16"
            />
          </button>
        </div>
      )}

      <div
        className={cn(
          "flex items-end gap-2 rounded-3xl border border-[#444444] bg-[#1F2023] px-3 py-2",
          "shadow-[0_8px_30px_rgba(0,0,0,0.24)] transition-all duration-300",
          "focus-within:border-[#555555]",
          voice.isListening && "border-purple-500/50 shadow-[0_0_20px_rgba(168,85,247,0.15)]"
        )}
      >
        {/* Voice input button */}
        {voice.isSupported && (
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.button
                onClick={voice.toggle}
                disabled={isLoading || voice.isTranscribing}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className={cn(
                  "h-9 w-9 shrink-0 mb-1 rounded-full inline-flex items-center justify-center",
                  "transition-all duration-200 focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-50",
                  voice.isTranscribing
                    ? "bg-amber-500/20 text-amber-400"
                    : voice.isListening
                      ? "bg-purple-500/20 text-purple-400"
                      : "bg-transparent text-[#9CA3AF] hover:text-gray-200"
                )}
              >
                {voice.isTranscribing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : voice.isListening ? (
                  <MicOff className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </motion.button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {voice.isTranscribing
                ? "Transcribing..."
                : voice.isListening
                  ? "Stop recording"
                  : "Voice input"}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Textarea */}
        <div className="flex-1 flex flex-col">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={voice.isListening ? "Listening..." : placeholder}
            rows={1}
            disabled={isLoading}
            className={cn(
              "flex-1 rounded-md border-none bg-transparent px-1 py-2.5",
              "text-[16px] text-gray-100 placeholder:text-gray-400",
              "focus-visible:outline-none focus-visible:ring-0",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "min-h-[44px] resize-none",
              voice.isListening && "placeholder:text-purple-400/60"
            )}
          />
          {/* Interim transcription preview */}
          {voice.isListening && voice.interim && (
            <div className="px-1 pb-1 text-sm text-gray-400 italic truncate">
              {voice.interim}
            </div>
          )}
        </div>

        {/* Send / Cancel button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.button
              onClick={isLoading && onCancel ? onCancel : handleSubmit}
              disabled={!isLoading && !hasContent}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className={cn(
                "h-9 w-9 shrink-0 mb-1 rounded-full inline-flex items-center justify-center",
                "transition-all duration-200 focus-visible:outline-none",
                "disabled:pointer-events-none disabled:opacity-50",
                isLoading
                  ? "bg-red-500 hover:bg-red-400 text-white"
                  : hasContent
                    ? "bg-white hover:bg-white/80 text-[#1F2023]"
                    : "bg-transparent text-[#9CA3AF]"
              )}
            >
              {isLoading ? (
                <Square className="h-3.5 w-3.5 fill-current" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </motion.button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {isLoading ? "Cancel" : hasContent ? "Send message" : "Type a message"}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
