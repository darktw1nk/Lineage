import { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
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

  // Listen for evaluation errors from backend
  useEffect(() => {
    if (!selectedEvaluationId) return;

    const handleUpdate = (_event: any, data: any) => {
      if (!data) return;
      
      console.log('[App] Evaluation update:', data);
      
      // Handle error updates
      if (data.type === 'error') {
        toast.error(data.message || 'Something went wrong', {
          duration: 5000,
        });
      }
    };

    window.electronAPI.eval.subscribe(selectedEvaluationId, handleUpdate);
    
    return () => {
      // Cleanup listeners when evaluation changes
    };
  }, [selectedEvaluationId]);

  return (
    <QueryClientProvider client={queryClient}>
      <Toaster position="top-right" richColors closeButton />
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

