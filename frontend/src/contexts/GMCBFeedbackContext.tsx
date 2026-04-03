import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { todayIso, createFeedbackDraft, type FeedbackItem, type FeedbackDraft } from "@/pages/gmcb/gmcbData";
import { FeedbackModal } from "@/pages/gmcb/gmcbComponents";

interface GMCBFeedbackContextValue {
  feedbacks: FeedbackItem[];
  openFeedbackModal: (preset?: Record<string, string>) => void;
}

const Ctx = createContext<GMCBFeedbackContextValue | null>(null);

export function GMCBFeedbackProvider({ children }: { children: ReactNode }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<FeedbackDraft>(createFeedbackDraft);
  const [feedbacks, setFeedbacks] = useState<FeedbackItem[]>([]);

  const openFeedbackModal = useCallback((preset: Record<string, string> = {}) => {
    setDraft((c) => ({ ...c, ...preset }));
    setModalOpen(true);
  }, []);

  const closeFeedbackModal = useCallback(() => {
    setModalOpen(false);
    setDraft(createFeedbackDraft());
  }, []);

  const submitFeedback = useCallback(() => {
    const payload: FeedbackItem = {
      id: `fb-${Date.now()}`,
      title: draft.title || draft.type || "Feedback",
      comment: draft.comment || "",
      type: draft.type || "bug",
      scope: draft.scope || "global",
      date: draft.date || todayIso(),
      sessionId: draft.sessionId || null,
      urgency: draft.urgency || "medium",
      createdAt: new Date().toISOString(),
    };
    setFeedbacks((c) => [payload, ...c]);
    closeFeedbackModal();
  }, [draft, closeFeedbackModal]);

  return (
    <Ctx.Provider value={{ feedbacks, openFeedbackModal }}>
      {children}
      {modalOpen && (
        <FeedbackModal draft={draft} onChange={setDraft} onClose={closeFeedbackModal} onSubmit={submitFeedback} />
      )}
    </Ctx.Provider>
  );
}

export function useGMCBFeedback() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useGMCBFeedback must be used within GMCBFeedbackProvider");
  return ctx;
}
