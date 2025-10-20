import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeftSidebar } from './components/LeftSidebar';
import { CenterView } from './components/CenterView';
import { RightPanel } from './components/RightPanel';
import { Footer } from './components/Footer';
import { SettingsModal } from './components/SettingsModal';
import { NewEvaluationModal } from './components/NewEvaluationModal';
import type { CandidateNode, UUID } from './types';

const queryClient = new QueryClient();

function App() {
  const [selectedEvaluationId, setSelectedEvaluationId] = useState<UUID | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<UUID | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewEvaluation, setShowNewEvaluation] = useState(false);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex h-screen w-screen overflow-hidden bg-background">
        {/* Left Sidebar */}
        <LeftSidebar
          onNewEvaluation={() => setShowNewEvaluation(true)}
          onSettings={() => setShowSettings(true)}
          onSelectEvaluation={setSelectedEvaluationId}
          selectedEvaluationId={selectedEvaluationId}
        />

        {/* Main Content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <CenterView
            evaluationId={selectedEvaluationId}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
          />
          <Footer evaluationId={selectedEvaluationId} />
        </div>

        {/* Right Panel */}
        {selectedNodeId && (
          <RightPanel
            evaluationId={selectedEvaluationId}
            nodeId={selectedNodeId}
            onClose={() => setSelectedNodeId(null)}
          />
        )}

        {/* Modals */}
        {showSettings && (
          <SettingsModal onClose={() => setShowSettings(false)} />
        )}
        {showNewEvaluation && (
          <NewEvaluationModal
            onClose={() => setShowNewEvaluation(false)}
            onCreated={(evalId) => {
              setShowNewEvaluation(false);
              setSelectedEvaluationId(evalId);
            }}
          />
        )}
      </div>
    </QueryClientProvider>
  );
}

export default App;

