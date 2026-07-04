"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ChevronLeft } from "lucide-react";

const FAQ_ITEMS = [
  {
    question: "How do I start a conversation?",
    answer:
      "Simply type your question in the chat input at the bottom of the screen, or tap the voice button to speak your question. The AI assistant will respond with helpful information about Scouting America.",
  },
  {
    question: "Is the chatbot available 24/7?",
    answer:
      "Yes, the Scouting America AI assistant is available 24 hours a day, 7 days a week. You can ask questions at any time and get instant responses.",
  },
  {
    question: "How accurate are the chatbot's answers?",
    answer:
      "The chatbot provides information based on official Scouting America resources. While we strive for accuracy, AI may occasionally make mistakes. For critical decisions, we recommend verifying information with your local council.",
  },
  {
    question: "Does the chatbot collect personal information?",
    answer:
      "The chatbot processes your messages to provide relevant responses. We do not store personal information beyond the current session unless you explicitly provide it for account-related features.",
  },
  {
    question: "Can I share a conversation with others?",
    answer:
      "Currently, conversations are private to your session. We are working on features to allow sharing helpful responses with others in the future.",
  },
];

interface FAQViewProps {
  onBack?: () => void;
}

export default function FAQView({ onBack }: FAQViewProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <>
      <div className="faq-header-bar">
        <button className="faq-back-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={18} />
        </button>
        <h2 className="faq-title">Help</h2>
      </div>
      <div className="faq-container">
        {FAQ_ITEMS.map((item, index) => (
          <div key={index} className="faq-item">
            <button
              className="faq-question"
              onClick={() =>
                setOpenIndex(openIndex === index ? null : index)
              }
              aria-expanded={openIndex === index}
            >
              <span className="faq-question-text">{item.question}</span>
              {openIndex === index ? (
                <ChevronUp size={16} className="faq-chevron" />
              ) : (
                <ChevronDown size={16} className="faq-chevron" />
              )}
            </button>
            {openIndex === index && (
              <div className="faq-answer animate-in">{item.answer}</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
