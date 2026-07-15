"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ChevronLeft } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

interface FAQViewProps {
  onBack?: () => void;
}

export default function FAQView({ onBack }: FAQViewProps) {
  const { t } = useLanguage();
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <>
      <div className="faq-header-bar">
        <button className="faq-back-btn" onClick={onBack} aria-label={t.common.back}>
          <ChevronLeft size={18} />
        </button>
        <h2 className="faq-title">{t.faq.title}</h2>
      </div>
      <div className="faq-container">
        {t.faq.items.map((item, index) => (
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
