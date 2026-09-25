import { useState } from 'react';
import { customConfirm } from '../../../utils';
import { useExamBuilder } from '../questions/useExamBuilder';
import ExamCreationWizard from './ExamCreationWizard';

/**
 * The wizard with its own selection and builder state, for entry points that
 * are not the Question Bank screen (the Dashboard Overview "Create exam").
 * @param {{ onClose: () => void, onExamCreated: () => void }} props
 */
export default function StandaloneExamWizard({ onClose, onExamCreated }) {
  const [selectedQuestions, setSelectedQuestions] = useState(/** @type {string[]} */ ([]));
  const examBuilder = useExamBuilder({
    selectedQuestions,
    setSelectedQuestions,
    onExamCreated: () => {
      onExamCreated();
      onClose();
    }
  });

  const hasDraft = selectedQuestions.length > 0 || examBuilder.newExamTitle.trim() !== '';
  const requestClose = async () => {
    if (hasDraft && !await customConfirm('Discard this exam draft? The title and selected questions will be lost.')) return;
    onClose();
  };

  return (
    <ExamCreationWizard
      examBuilder={examBuilder}
      selectedQuestions={selectedQuestions}
      setSelectedQuestions={setSelectedQuestions}
      onClose={requestClose}
    />
  );
}
