"use client";

import { RefObject } from "react";
import { ChatMessage } from "@/lib/api";
import WelcomeView from "./WelcomeView";
import MessageBubble from "./MessageBubble";
import TypingIndicator from "./TypingIndicator";
import MediaControls from "./MediaControls";

interface ChatAreaProps {
  messages: ChatMessage[];
  isLoading: boolean;
  showWelcome: boolean;
  onChipClick: (text: string) => void;
  onEndChat: () => void;
  chatEndRef: RefObject<HTMLDivElement | null>;
}

export default function ChatArea({
  messages,
  isLoading,
  showWelcome,
  onChipClick,
  onEndChat,
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
            />
          ))}
          {isLoading && <TypingIndicator />}
          {messages.length > 0 && (
            <MediaControls onEndChat={onEndChat} />
          )}
        </>
      )}
      <div ref={chatEndRef} />
    </div>
  );
}
