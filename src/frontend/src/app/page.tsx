"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { ChatInput } from "@/components/chat-input";
import { MessageBubble, type Message } from "@/components/message-bubble";
import { PatientBanner } from "@/components/patient-banner";
import { StatusBar } from "@/components/status-bar";
import { ReferenceSidebar } from "@/components/reference-sidebar";
import { KnowledgeGraph } from "@/components/knowledge-graph";
import { DecisionTreeViewer } from "@/components/decision-tree-viewer";
import { ReferenceLegend } from "@/components/reference-legend";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { CerebraLinkLogo } from "@/components/ui/cerebralink-logo";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8100";

interface AgentStatusItem {
  agent: string;
  status: "running" | "done" | "error";
  message?: string;
  time_ms?: number;
  tokens?: { input_tokens: number; output_tokens: number };
}

interface DecisionTreeData {
  title: string;
  nodes: { id: string; type?: string; data: Record<string, unknown>; position: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string; label?: string }[];
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [patientSummary, setPatientSummary] = useState<string | null>(null);
  const [patientData, setPatientData] = useState<Record<string, unknown> | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<AgentStatusItem[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [totalTokens, setTotalTokens] = useState({ input: 0, output: 0 });

  // Sidebar & modal state
  const [showReferences, setShowReferences] = useState(false);
  const [showKnowledgeGraph, setShowKnowledgeGraph] = useState(false);
  const [activeDecisionTree, setActiveDecisionTree] = useState<DecisionTreeData | null>(null);
  const [refUrl, setRefUrl] = useState<string | undefined>(undefined);
  const [refTitle, setRefTitle] = useState<string | undefined>(undefined);

  // Abort controller for cancelling requests
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleOpenReferenceUrl = useCallback((url: string, title: string) => {
    setRefUrl(url);
    setRefTitle(title);
    setShowReferences(true);
  }, []);

  // Find the latest message with citations/guidelines for the reference sidebar
  const latestRefMsg = [...messages].reverse().find(
    (m) => m.role === "assistant" && ((m.citations && m.citations.length > 0) || (m.guidelines_used && m.guidelines_used.length > 0))
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingMsgIdRef = useRef<string | null>(null);

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

  const handleCancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
    stopTimer();
  }, [stopTimer]);

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
    pendingMsgIdRef.current = null;
    startTimer();

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const resp = await fetch(`${API_URL}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, session_id: sessionId }),
        signal: controller.signal,
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (!resp.body) throw new Error("No response body");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const dataStr = line.slice(6);
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

                if (data.status === "done" && data.tokens) {
                  setTotalTokens((prev) => ({
                    input: prev.input + (data.tokens.input_tokens || 0),
                    output: prev.output + (data.tokens.output_tokens || 0),
                  }));
                }

                // If patient_fetch succeeded, store patient data
                if (data.agent === "patient_fetch" && data.status === "done") {
                  // Patient data will come in the result event
                }
              } else if (eventType === "fast_answer") {
                const msgId = crypto.randomUUID();
                pendingMsgIdRef.current = msgId;
                const fastMsg: Message = {
                  id: msgId,
                  role: "assistant",
                  content: data.fast_answer,
                  fast_answer: data.fast_answer,
                  guidelines_used: data.guidelines_used,
                  citations: data.citations,
                  timestamp: Date.now(),
                };
                setMessages((prev) => [...prev, fastMsg]);
              } else if (eventType === "result") {
                if (!sessionId) setSessionId(data.session_id);

                // Store patient data if available in the result
                if (data.patient_context) {
                  setPatientData(data.patient_context);
                  const pt = data.patient_context.patient || data.patient_context;
                  setPatientSummary(
                    pt.full_name ||
                    pt.page_title ||
                    data.patient_context.full_name ||
                    data.patient_context.page_title ||
                    "Patient data loaded"
                  );
                }

                const pendingId = pendingMsgIdRef.current;
                const fullMsg: Message = {
                  id: pendingId || crypto.randomUUID(),
                  role: "assistant",
                  content: data.fast_answer,
                  fast_answer: data.fast_answer,
                  complete_answer: data.complete_answer,
                  trust_scores: data.trust_scores,
                  trust_reasons: data.trust_reasons,
                  scorer_confidence: data.scorer_confidence,
                  guidelines_used: data.guidelines_used,
                  citations: data.citations,
                  agents_used: data.agents_used,
                  agent_timings: data.agent_timings,
                  total_time_ms: data.total_time_ms,
                  total_input_tokens: data.total_input_tokens,
                  total_output_tokens: data.total_output_tokens,
                  decision_tree: data.decision_tree,
                  language: data.language,
                  priority_country: data.priority_country,
                  timestamp: Date.now(),
                };

                setMessages((prev) => {
                  // Strategy 1: Replace by pending ID
                  if (pendingId) {
                    const idx = prev.findIndex((m) => m.id === pendingId);
                    if (idx >= 0) {
                      const next = [...prev];
                      next[idx] = fullMsg;
                      return next;
                    }
                  }
                  // Strategy 2: Replace the last fast-only assistant message
                  for (let i = prev.length - 1; i >= 0; i--) {
                    if (
                      prev[i].role === "assistant" &&
                      prev[i].fast_answer &&
                      !prev[i].complete_answer
                    ) {
                      const next = [...prev];
                      next[i] = { ...fullMsg, id: prev[i].id };
                      return next;
                    }
                  }
                  // Strategy 3: Append as new message
                  return [...prev, fullMsg];
                });
                pendingMsgIdRef.current = null;
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
      if (err instanceof DOMException && err.name === "AbortError") {
        // User cancelled — do nothing
      } else {
        const errorMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Connection error: ${err instanceof Error ? err.message : "Unknown error"}. Make sure the backend is running on ${API_URL}.`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      }
    } finally {
      setIsLoading(false);
      stopTimer();
      abortControllerRef.current = null;
    }
  };

  const handleNewChat = async () => {
    handleCancel();
    if (sessionId) {
      await fetch(`${API_URL}/api/patient/clear?session_id=${sessionId}`, {
        method: "POST",
      }).catch(() => {});
    }
    setPatientSummary(null);
    setPatientData(null);
    setSessionId(null);
    setMessages([]);
    setAgentStatuses([]);
    setShowReferences(false);
    setActiveDecisionTree(null);
    setShowKnowledgeGraph(false);
  };

  // Check for patient data on session
  useEffect(() => {
    if (!sessionId) return;
    fetch(`${API_URL}/api/session/${sessionId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.patient_summary) {
          setPatientSummary(data.patient_summary);
        }
      })
      .catch(() => {});
  }, [sessionId]);

  return (
    <div className="flex h-screen relative">
      {/* Main chat area — always centered */}
      <div className="flex flex-col mx-auto w-full max-w-[720px] min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-border/30">
          <div className="flex items-center gap-3">
            <CerebraLinkLogo size={38} />
            <div>
              <h1 className="text-xl font-bold text-gray-100">CerebraLink</h1>
              <p className="text-sm text-gray-500">Medical AI Assistant</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ReferenceLegend />
            {patientData && (
              <button
                onClick={() => setShowKnowledgeGraph(true)}
                className="text-xs text-emerald-400/80 hover:text-emerald-400 transition-colors px-3 py-1.5 rounded-lg border border-emerald-500/30 hover:border-emerald-500/50"
              >
                Knowledge Graph
              </button>
            )}
            <button
              onClick={handleNewChat}
              className="text-xs text-gray-400 hover:text-gray-200 transition-colors px-3 py-1.5 rounded-lg border border-border/50 hover:border-border bg-surface hover:bg-surface-light"
            >
              + New Chat
            </button>
          </div>
        </header>

        {/* Patient Banner */}
        {patientSummary && <PatientBanner summary={patientSummary} />}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="mb-4">
                <CerebraLinkLogo size={80} />
              </div>
              <h2 className="text-xl font-bold text-gray-200 mb-2">
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
            <MessageBubble
              key={msg.id}
              message={msg}
              onOpenDecisionTree={(tree) => setActiveDecisionTree(tree)}
              onOpenKnowledgeGraph={() => setShowKnowledgeGraph(true)}
              onOpenReferences={() => setShowReferences(true)}
              onOpenReferenceUrl={handleOpenReferenceUrl}
              hasPatientData={!!patientData}
            />
          ))}

          {/* Status bar */}
          {isLoading && agentStatuses.length > 0 && (
            <StatusBar
              agents={agentStatuses}
              elapsed={elapsed}
              totalTokens={totalTokens}
            />
          )}

          {isLoading && agentStatuses.length === 0 && (
            <div className="pl-2">
              <ShimmerText text="Connecting to agent council..." showChevron={false} />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Chat Input */}
        <div className="px-4 pb-6 pt-2">
          <ChatInput onSend={handleSend} isLoading={isLoading} onCancel={handleCancel} />
        </div>
      </div>

      {/* Reference Sidebar — fixed to right edge, overlays content */}
      {showReferences && latestRefMsg && (
        <div className="fixed top-0 right-0 h-screen w-[min(420px,33vw)] z-40 border-l border-border/30 bg-[#131316]">
          <ReferenceSidebar
            citations={latestRefMsg.citations || []}
            guidelines={latestRefMsg.guidelines_used || []}
            onClose={() => { setShowReferences(false); setRefUrl(undefined); setRefTitle(undefined); }}
            initialUrl={refUrl}
            initialTitle={refTitle}
          />
        </div>
      )}

      {/* Knowledge Graph Modal */}
      {showKnowledgeGraph && patientData && (
        <KnowledgeGraph
          patientData={patientData}
          onClose={() => setShowKnowledgeGraph(false)}
        />
      )}

      {/* Decision Tree Modal */}
      {activeDecisionTree && (
        <DecisionTreeViewer
          title={activeDecisionTree.title}
          nodes={activeDecisionTree.nodes}
          edges={activeDecisionTree.edges}
          onClose={() => setActiveDecisionTree(null)}
        />
      )}
    </div>
  );
}
