"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { ChatInput } from "@/components/chat-input";
import { MessageBubble } from "@/components/message-bubble";
import { PatientBanner } from "@/components/patient-banner";
import { StatusBar } from "@/components/status-bar";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8100";

interface TrustScores {
  evidence_quality: number;
  guideline_alignment: number;
  clinical_relevance: number;
  safety_check: number;
  completeness: number;
  source_recency: number;
}

interface Guideline {
  title: string;
  source: string;
  country: string;
  year?: number;
  url?: string;
}

interface Citation {
  index: number;
  title: string;
  source: string;
  country: string;
  year?: number;
  url?: string;
  quote: string;
}

interface AgentTiming {
  agent: string;
  time_ms: number;
  input_tokens: number;
  output_tokens: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  fast_answer?: string;
  complete_answer?: string;
  trust_scores?: TrustScores;
  guidelines_used?: Guideline[];
  citations?: Citation[];
  agents_used?: string[];
  agent_timings?: AgentTiming[];
  total_time_ms?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  timestamp: number;
}

interface AgentStatusItem {
  agent: string;
  status: "running" | "done" | "error";
  message?: string;
  time_ms?: number;
  tokens?: { input_tokens: number; output_tokens: number };
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [patientSummary, setPatientSummary] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<AgentStatusItem[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [totalTokens, setTotalTokens] = useState({ input: 0, output: 0 });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, agentStatuses, scrollToBottom]);

  const startTimer = useCallback(() => {
    const t0 = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Date.now() - t0);
    }, 100);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);
    setAgentStatuses([]);
    setElapsed(0);
    setTotalTokens({ input: 0, output: 0 });
    startTimer();

    try {
      const resp = await fetch(`${API_URL}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, session_id: sessionId }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (!resp.body) throw new Error("No response body");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        let dataStr = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            dataStr = line.slice(6);
            try {
              const data = JSON.parse(dataStr);

              if (eventType === "status") {
                setAgentStatuses((prev) => {
                  const existing = prev.findIndex(
                    (a) => a.agent === data.agent
                  );
                  const item: AgentStatusItem = {
                    agent: data.agent,
                    status: data.status,
                    message: data.message,
                    time_ms: data.time_ms,
                    tokens: data.tokens,
                  };
                  if (existing >= 0) {
                    const next = [...prev];
                    next[existing] = item;
                    return next;
                  }
                  return [...prev, item];
                });

                // Update token totals from done agents
                if (data.status === "done" && data.tokens) {
                  setTotalTokens((prev) => ({
                    input: prev.input + (data.tokens.input_tokens || 0),
                    output: prev.output + (data.tokens.output_tokens || 0),
                  }));
                }
              } else if (eventType === "result") {
                if (!sessionId) setSessionId(data.session_id);

                const assistantMsg: Message = {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: data.fast_answer,
                  fast_answer: data.fast_answer,
                  complete_answer: data.complete_answer,
                  trust_scores: data.trust_scores,
                  guidelines_used: data.guidelines_used,
                  citations: data.citations,
                  agents_used: data.agents_used,
                  agent_timings: data.agent_timings,
                  total_time_ms: data.total_time_ms,
                  total_input_tokens: data.total_input_tokens,
                  total_output_tokens: data.total_output_tokens,
                  timestamp: Date.now(),
                };
                setMessages((prev) => [...prev, assistantMsg]);
              } else if (eventType === "error") {
                const errorMsg: Message = {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: `Error: ${data.message}`,
                  timestamp: Date.now(),
                };
                setMessages((prev) => [...prev, errorMsg]);
              }
            } catch {
              // skip malformed JSON
            }
          }
        }
      }
    } catch (err) {
      const errorMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `Connection error: ${err instanceof Error ? err.message : "Unknown error"}. Make sure the backend is running on ${API_URL}.`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
      stopTimer();
    }
  };

  const handleClearPatient = async () => {
    if (sessionId) {
      await fetch(`${API_URL}/api/patient/clear?session_id=${sessionId}`, {
        method: "POST",
      }).catch(() => {});
    }
    setPatientSummary(null);
    setSessionId(null);
    setMessages([]);
  };

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-border/30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-white font-bold text-sm">
            C
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-100">CerebraLink</h1>
            <p className="text-xs text-gray-500">Medical AI Assistant</p>
          </div>
        </div>
        {patientSummary && (
          <button
            onClick={handleClearPatient}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-3 py-1.5 rounded-lg border border-border/50 hover:border-border"
          >
            New Patient
          </button>
        )}
      </header>

      {/* Patient Banner */}
      {patientSummary && <PatientBanner summary={patientSummary} />}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
              <span className="text-3xl text-accent">C</span>
            </div>
            <h2 className="text-xl font-semibold text-gray-200 mb-2">
              CerebraLink
            </h2>
            <p className="text-gray-500 max-w-md text-sm leading-relaxed">
              Medical AI assistant with multi-agent council. Ask any clinical
              question — get fast and complete answers backed by the latest
              guidelines with LaTeX calculations.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Status bar — shown during loading */}
        {isLoading && agentStatuses.length > 0 && (
          <StatusBar
            agents={agentStatuses}
            elapsed={elapsed}
            totalTokens={totalTokens}
          />
        )}

        {/* Simple loading indicator before first status arrives */}
        {isLoading && agentStatuses.length === 0 && (
          <div className="flex items-center gap-2 text-gray-500 text-sm pl-2">
            <div className="flex gap-1">
              <span
                className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce"
                style={{ animationDelay: "0ms" }}
              />
              <span
                className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce"
                style={{ animationDelay: "150ms" }}
              />
              <span
                className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce"
                style={{ animationDelay: "300ms" }}
              />
            </div>
            <span>Connecting...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Chat Input */}
      <div className="px-6 pb-6 pt-2">
        <ChatInput onSend={handleSend} isLoading={isLoading} />
      </div>
    </div>
  );
}
