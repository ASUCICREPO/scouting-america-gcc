"use client";

import { ArrowRight, Languages } from "lucide-react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useLanguage } from "@/context/LanguageContext";

interface LanguageConfirmModalProps {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function LanguageConfirmModal({ isOpen, onCancel, onConfirm }: LanguageConfirmModalProps) {
  const { t } = useLanguage();

  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={t.chat.changeLanguageTitle}
      description={t.chat.changeLanguageMessage}
      confirmLabel={t.common.continue}
      cancelLabel={t.common.cancel}
      closeLabel={t.common.close}
      onConfirm={onConfirm}
      onCancel={onCancel}
      icon={<Languages size={21} />}
      confirmIcon={<ArrowRight size={16} />}
    />
  );
}
