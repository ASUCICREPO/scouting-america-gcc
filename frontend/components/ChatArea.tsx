"use client";

import { RefObject } from "react";
import { ChatMessage } from "@/lib/api";
import WelcomeView from "./WelcomeView";
import MessageBubble from "./MessageBubble";
import TypingIndicator from "./TypingIndicator";

interface ChatAreaProps {
  messages: ChatMessage[];
  isLoading: boolean;
  showWelcome: boolean;
  onChipClick: (text: string) => void;
  onEndChat: () => void;
  onFeedback: (index: number, feedback: "positive" | "negative") => void;
  chatEndRef: RefObject<HTMLDivElement | null>;
}

export default function ChatArea({
  messages,
  isLoading,
  showWelcome,
  onChipClick,
  onEndChat,
  onFeedback,
  chatEndRef,
}: ChatAreaProps) {
  return (
    <div className="chat-area">
      {showWelcome && messages.length === 0 ? (
        <WelcomeView onChipClick={onChipClick} />
      ) : (
        <>
          {messages.map((msg, index) => (
            <MessageBubble
              key={index}
              message={msg}
              onChipClick={onChipClick}
              onFeedback={(feedback) => onFeedback(index, feedback)}
            />
          ))}
          {isLoading && <TypingIndicator />}
        </>
      )}
      <div ref={chatEndRef} />
    </div>
  );
}
