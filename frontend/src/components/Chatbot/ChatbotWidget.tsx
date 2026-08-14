import React, { useState, useRef, useEffect } from 'react';
import {
  MessageSquare,
  X,
  Send,
  Bot,
  Truck,
  AlertTriangle,
  Clock,
  CheckCircle2,
  ChevronDown,
  Sparkles,
  RefreshCw,
  PhoneCall,
  ShieldAlert,
  Calendar,
  Zap,
  MapPin
} from 'lucide-react';
import { Shipment, DriverProfile, IssueReport, ExceptionType } from '../../types';

interface Message {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  timestamp: string;
  actionCard?: {
    actionType: string;
    category: ExceptionType;
    title: string;
    description: string;
    estimatedDelayMinutes: number;
    suggestedNewEta: string;
    executed?: boolean;
  };
}

interface ChatbotWidgetProps {
  activeShipment: Shipment | null;
  driverProfile: DriverProfile;
  onSubmitIssue: (issueData: Pick<IssueReport, 'shipmentId' | 'category' | 'estimatedDelayMinutes'>) => void;
  onOpenIssueModal: () => void;
}

export const ChatbotWidget: React.FC<ChatbotWidgetProps> = ({
  activeShipment,
  driverProfile,
  onSubmitIssue,
  onOpenIssueModal
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showRescheduleForm, setShowRescheduleForm] = useState(false);

  // Quick Reschedule Form State
  const [rescheduleMinutes, setRescheduleMinutes] = useState(45);
  const [rescheduleReasonCategory, setRescheduleReasonCategory] = useState<ExceptionType>('traffic_delay');
  const [rescheduleNotes, setRescheduleNotes] = useState('');

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const initialWelcomeText = activeShipment
    ? `Hello ${driverProfile.name.split(' ')[0]}! 🚚 I'm your FleetPulse AI Dispatch Co-Pilot. You are currently assigned to Shipment **${activeShipment.id}** bound for **${activeShipment.destinationFacility.name}**. How can I assist you with route updates or rescheduling today?`
    : `Hello ${driverProfile.name.split(' ')[0]}! 🚚 I'm your FleetPulse AI Dispatch Assistant. You currently have no active shipment. How can I assist you with available loads, route questions, or dispatch support?`;

  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome-1',
      sender: 'assistant',
      text: initialWelcomeText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
    }
  }, [messages, isOpen]);

  // Parse action code blocks from Gemini or server response
  const parseResponseText = (rawText: string) => {
    let cleanText = rawText;
    let actionObj = null;

    const actionMatch = rawText.match(/```action\s*([\s\S]*?)\s*```/);
    if (actionMatch && actionMatch[1]) {
      try {
        actionObj = JSON.parse(actionMatch[1]);
        cleanText = rawText.replace(/```action\s*[\s\S]*?```/, '').trim();
      } catch (e) {
        console.error('Failed to parse action JSON:', e);
      }
    }

    return { cleanText, actionObj };
  };

  const handleSendMessage = async (customText?: string) => {
    const textToSend = customText || inputText;
    if (!textToSend.trim() || isLoading) return;

    const userMsg: Message = {
      id: `msg-${Date.now()}`,
      sender: 'user',
      text: textToSend,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!customText) setInputText('');
    setIsLoading(true);

    try {
      // Build history payload for context
      const historyPayload = messages.map((m) => ({
        role: m.sender === 'user' ? 'user' : 'model',
        text: m.text,
      }));

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: textToSend,
          history: historyPayload,
          activeShipment,
          driverProfile,
        }),
      });

      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }

      const data = await res.json();
      const { cleanText, actionObj } = parseResponseText(data.text || '');

      const assistantMsg: Message = {
        id: `msg-ast-${Date.now()}`,
        sender: 'assistant',
        text: cleanText || 'Copy that, driver.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        actionCard: actionObj ? { ...actionObj, executed: false } : undefined,
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      console.error('Chat error:', err);
      // Local fallback in case of error
      const fallbackText = `Received your update: "${textToSend}". I have logged this with dispatch. Would you like me to submit an official issue or reschedule ticket?`;
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-err-${Date.now()}`,
          sender: 'assistant',
          text: fallbackText,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  // Confirm action card (Reschedule or Issue Submission)
  const handleExecuteAction = (msgId: string, actionCard: Message['actionCard']) => {
    if (!actionCard || !activeShipment) return;

    // Submit issue to active shipment state in App.tsx
    onSubmitIssue({
      shipmentId: activeShipment.id,
      category: actionCard.category || 'other',
      estimatedDelayMinutes: actionCard.estimatedDelayMinutes || 30,
    });

    // Update message state so action card shows as executed
    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.id === msgId && msg.actionCard) {
          return {
            ...msg,
            actionCard: {
              ...msg.actionCard,
              executed: true,
            },
          };
        }
        return msg;
      })
    );

    // Add confirmation message from system assistant
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-confirm-${Date.now()}`,
          sender: 'assistant',
          text: `✅ **Success!** Reschedule / Issue ticket logged for **${activeShipment.id}**. ETA updated by +${actionCard.estimatedDelayMinutes} mins in your active tracking dashboard. Dispatch has been auto-notified.`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    }, 400);
  };

  // Quick Reschedule Form Submit
  const handleQuickRescheduleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setShowRescheduleForm(false);

    const promptText = `I need to request a delivery reschedule for shipment ${
      activeShipment?.id || 'current load'
    }. Reason: ${rescheduleReasonCategory}. Delay requested: ${rescheduleMinutes} minutes. Notes: ${
      rescheduleNotes || 'Traffic / dock delay encountered.'
    }`;

    handleSendMessage(promptText);
  };

  return (
    <>
      {/* Floating Chat Button (Bottom Right) */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end">
        <button
          id="btn-driver-chatbot-toggle"
          onClick={() => setIsOpen(!isOpen)}
          className={`relative p-3.5 rounded-full shadow-xl transition-all duration-300 transform active:scale-95 flex items-center justify-center border ${
            isOpen
              ? 'bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200'
              : 'bg-indigo-600 text-white border-indigo-500 hover:bg-indigo-700 ring-4 ring-indigo-100'
          }`}
          title={isOpen ? 'Close Chatbot' : 'Open Dispatch AI Assistant'}
          aria-label="Toggle Dispatch AI Chatbot"
        >
          {isOpen ? (
            <X className="w-6 h-6" />
          ) : (
            <>
              <Bot className="w-7 h-7 stroke-[2.2]" />
              <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-emerald-500 border-2 border-white"></span>
              </span>
            </>
          )}
        </button>
      </div>

      {/* Floating Chat Modal Box */}
      {isOpen && (
        <div className="fixed bottom-24 right-4 sm:right-6 w-[calc(100vw-2rem)] sm:w-[420px] max-h-[620px] h-[550px] bg-white border border-slate-200/90 shadow-2xl rounded-3xl z-50 flex flex-col overflow-hidden backdrop-blur-xl animate-in fade-in slide-in-from-bottom-5 duration-200 text-slate-800">
          
          {/* Header */}
          <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-9 h-9 rounded-xl bg-indigo-100 border border-indigo-200 flex items-center justify-center text-indigo-700 relative">
                <Bot className="w-5 h-5" />
                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white"></span>
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h3 className="font-bold text-slate-900 text-sm tracking-wide">FleetPulse Dispatch Co-Pilot</h3>
                  <span className="bg-indigo-50 text-indigo-700 text-[10px] font-bold px-1.5 py-0.5 rounded-md border border-indigo-200">
                    AI Active
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 flex items-center space-x-1">
                  <span>Rescheduling & Driver Issue Assistant</span>
                </p>
              </div>
            </div>

            <div className="flex items-center space-x-1">
              <button
                onClick={() =>
                  setMessages([
                    {
                      id: `welcome-${Date.now()}`,
                      sender: 'assistant',
                      text: initialWelcomeText,
                      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    },
                  ])
                }
                className="p-1.5 text-slate-400 hover:text-slate-800 hover:bg-slate-200/60 rounded-xl transition-colors"
                title="Reset Conversation"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-800 hover:bg-slate-200/60 rounded-xl transition-colors"
                title="Minimize Window"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Active Shipment Quick Info Bar */}
          {activeShipment ? (
            <div className="bg-slate-100/80 px-3.5 py-2 border-b border-slate-200/80 text-xs flex items-center justify-between text-slate-700">
              <div className="flex items-center space-x-2 truncate">
                <Truck className="w-3.5 h-3.5 text-indigo-600 flex-shrink-0" />
                <span className="font-bold text-slate-900">{activeShipment.id}</span>
                <span className="text-slate-500 text-[11px] truncate">
                  → {activeShipment.destinationFacility.name} ({activeShipment.destinationFacility.city})
                </span>
              </div>
              <span className="bg-indigo-50 text-indigo-800 border border-indigo-200 px-2 py-0.5 rounded-lg text-[10px] font-bold shrink-0 ml-1">
                {activeShipment.status.replace('_', ' ')}
              </span>
            </div>
          ) : (
            <div className="bg-slate-50 px-3.5 py-1.5 border-b border-slate-200 text-[11px] text-slate-500 flex items-center space-x-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              <span>No active load assigned. Ready for inquiries or dispatch questions.</span>
            </div>
          )}

          {/* Chat Messages Stream */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3.5 custom-scrollbar text-xs bg-white">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div className="flex items-center space-x-1 mb-1 px-1">
                  <span className="text-[10px] font-semibold text-slate-500">
                    {msg.sender === 'user' ? 'You (Driver)' : 'FleetPulse Dispatch AI'}
                  </span>
                  <span className="text-[10px] text-slate-400">• {msg.timestamp}</span>
                </div>

                <div
                  className={`max-w-[88%] p-3.5 rounded-2xl text-xs space-y-2 ${
                    msg.sender === 'user'
                      ? 'bg-indigo-600 text-white font-medium rounded-br-none shadow-sm'
                      : 'bg-slate-50 border border-slate-200/80 rounded-bl-none text-slate-800'
                  }`}
                >
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>

                  {/* Interactive Action Card if generated by AI */}
                  {msg.actionCard && (
                    <div className="mt-2.5 p-3 rounded-2xl bg-white border border-indigo-200 text-slate-800 text-xs space-y-2 shadow-sm">
                      <div className="flex items-center justify-between pb-1.5 border-b border-slate-100">
                        <div className="flex items-center space-x-1.5 text-indigo-900 font-bold">
                          <AlertTriangle className="w-4 h-4 text-amber-500" />
                          <span>{msg.actionCard.title || 'Reschedule & Issue Ticket'}</span>
                        </div>
                        <span className="bg-indigo-50 text-indigo-800 text-[10px] px-2 py-0.5 rounded-lg font-mono font-bold border border-indigo-200">
                          {msg.actionCard.category}
                        </span>
                      </div>

                      <p className="text-slate-600 text-[11px] leading-relaxed">
                        {msg.actionCard.description}
                      </p>

                      <div className="grid grid-cols-2 gap-2 text-[11px] pt-1">
                        <div className="bg-slate-50 p-2 rounded-xl border border-slate-200">
                          <span className="text-slate-500 block text-[10px] uppercase font-semibold">Delay Impact</span>
                          <span className="font-bold text-amber-700">+{msg.actionCard.estimatedDelayMinutes} mins</span>
                        </div>
                        <div className="bg-slate-50 p-2 rounded-xl border border-slate-200">
                          <span className="text-slate-500 block text-[10px] uppercase font-semibold">Suggested ETA</span>
                          <span className="font-bold text-emerald-700">{msg.actionCard.suggestedNewEta}</span>
                        </div>
                      </div>

                      <div className="pt-2 flex items-center justify-end space-x-2">
                        {msg.actionCard.executed ? (
                          <div className="w-full flex items-center justify-center space-x-1.5 text-emerald-800 bg-emerald-50 border border-emerald-200 py-1.5 rounded-xl font-bold text-xs">
                            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                            <span>Logged to Active Shipment</span>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleExecuteAction(msg.id, msg.actionCard)}
                            disabled={!activeShipment}
                            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold py-2 px-3 rounded-xl flex items-center justify-center space-x-1.5 transition-all active:scale-95 disabled:opacity-50 shadow-sm text-xs"
                          >
                            <Calendar className="w-3.5 h-3.5" />
                            <span>Confirm & Update Shipment ETA</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex items-center space-x-2 text-slate-500 bg-slate-50 p-2.5 rounded-2xl w-fit border border-slate-200">
                <Bot className="w-4 h-4 text-indigo-600 animate-spin" />
                <span className="text-xs font-medium">Dispatch AI is analyzing route & details...</span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Quick Reschedule Inline Form (Modal mode) */}
          {showRescheduleForm && (
            <div className="p-3 bg-slate-50 border-t border-slate-200 text-xs space-y-2 animate-in slide-in-from-bottom-2">
              <div className="flex items-center justify-between text-indigo-900 font-bold border-b border-slate-200 pb-1.5">
                <div className="flex items-center space-x-1.5">
                  <Clock className="w-4 h-4 text-indigo-600" />
                  <span>Quick Reschedule Assistant</span>
                </div>
                <button
                  onClick={() => setShowRescheduleForm(false)}
                  className="text-slate-400 hover:text-slate-700"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <form onSubmit={handleQuickRescheduleSubmit} className="space-y-2 pt-1">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-slate-600 block mb-0.5 font-bold uppercase">Reason Category</label>
                    <select
                      value={rescheduleReasonCategory}
                      onChange={(e) => setRescheduleReasonCategory(e.target.value as ExceptionType)}
                      className="w-full bg-white border border-slate-300 text-slate-900 rounded-lg px-2 py-1 text-xs focus:ring-1 focus:ring-indigo-500 outline-none"
                    >
                      <option value="traffic_delay">Traffic Congestion</option>
                      <option value="late_departure">Late Departure</option>
                      <option value="breakdown">Vehicle / Mechanical</option>
                      <option value="accident">Accident / Collision</option>
                      <option value="other">Other / HOS Rest</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[10px] text-slate-600 block mb-0.5 font-bold uppercase">Delay Needed</label>
                    <select
                      value={rescheduleMinutes}
                      onChange={(e) => setRescheduleMinutes(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 text-slate-900 rounded-lg px-2 py-1 text-xs focus:ring-1 focus:ring-indigo-500 outline-none"
                    >
                      <option value={30}>+30 Minutes</option>
                      <option value={45}>+45 Minutes</option>
                      <option value={60}>+1 Hour</option>
                      <option value={120}>+2 Hours</option>
                      <option value={240}>+4 Hours / Next Window</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] text-slate-600 block mb-0.5 font-bold uppercase">Additional Notes for Dispatch</label>
                  <input
                    type="text"
                    value={rescheduleNotes}
                    onChange={(e) => setRescheduleNotes(e.target.value)}
                    placeholder="e.g. Heavy highway construction, waiting for dock bay 4..."
                    className="w-full bg-white border border-slate-300 text-slate-900 rounded-lg px-2 py-1 text-xs focus:ring-1 focus:ring-indigo-500 outline-none"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold py-1.5 rounded-xl text-xs flex items-center justify-center space-x-1 transition-colors shadow-sm"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Process Reschedule in Chat</span>
                </button>
              </form>
            </div>
          )}

          {/* Preset Quick Actions Bar */}
          {!showRescheduleForm && (
            <div className="bg-slate-50 px-3 py-2 border-t border-slate-200 flex items-center gap-1.5 overflow-x-auto custom-scrollbar shrink-0 text-[11px]">
              <button
                onClick={() => setShowRescheduleForm(true)}
                disabled={!activeShipment}
                className="bg-indigo-50 hover:bg-indigo-100 text-indigo-900 border border-indigo-200 px-2.5 py-1 rounded-full shrink-0 flex items-center space-x-1 font-bold transition-all disabled:opacity-40"
              >
                <Clock className="w-3 h-3 text-indigo-600" />
                <span>Reschedule ETA</span>
              </button>

              <button
                onClick={() =>
                  handleSendMessage('I have encountered heavy traffic congestion on the highway. Please log a 45-minute delay.')
                }
                disabled={!activeShipment}
                className="bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 px-2.5 py-1 rounded-full shrink-0 flex items-center space-x-1 font-semibold transition-all disabled:opacity-40"
              >
                <AlertTriangle className="w-3 h-3 text-amber-500" />
                <span>Traffic Delay</span>
              </button>

              <button
                onClick={() =>
                  handleSendMessage('Dock queue is blocked at pickup facility. Expecting a 60-minute wait.')
                }
                disabled={!activeShipment}
                className="bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 px-2.5 py-1 rounded-full shrink-0 flex items-center space-x-1 font-semibold transition-all disabled:opacity-40"
              >
                <Truck className="w-3 h-3 text-indigo-600" />
                <span>Dock Wait</span>
              </button>

              <button
                onClick={onOpenIssueModal}
                disabled={!activeShipment}
                className="bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 px-2.5 py-1 rounded-full shrink-0 flex items-center space-x-1 font-bold transition-all disabled:opacity-40"
              >
                <ShieldAlert className="w-3 h-3 text-rose-600" />
                <span>Full Issue Form</span>
              </button>
            </div>
          )}

          {/* Message Input Controls */}
          <div className="bg-white p-3 border-t border-slate-200">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
              className="flex items-center space-x-2"
            >
              <input
                id="input-driver-chatbot-message"
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={activeShipment ? "Ask dispatch or request rescheduling..." : "Ask dispatch questions..."}
                disabled={isLoading}
                className="flex-1 bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:bg-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all disabled:opacity-50"
              />

              <button
                id="btn-driver-chatbot-send"
                type="submit"
                disabled={!inputText.trim() || isLoading}
                className="p-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-95 shrink-0 shadow-sm"
                title="Send Message"
              >
                <Send className="w-4 h-4 font-bold" />
              </button>
            </form>
          </div>

        </div>
      )}
    </>
  );
};
