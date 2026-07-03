// Mock data for testing — will be replaced with real API calls to backend

export const summaryData = {
  totalSessions: 48291,
  avgSessionLength: '6m 18s',
  activeUsers: 3814,
  escalationRate: 2814,
  sessionChange: '+12.4% this month',
  lengthChange: '+0m 42s vs last month',
  usersChange: '+8.1% this month',
  escalationChange: '+163% this month',
};

export const conversationVolumeData = [
  { date: 'Jun 1', count: 1200 },
  { date: 'Jun 3', count: 1350 },
  { date: 'Jun 5', count: 1500 },
  { date: 'Jun 7', count: 1800 },
  { date: 'Jun 9', count: 2100 },
  { date: 'Jun 11', count: 2400 },
  { date: 'Jun 13', count: 2800 },
  { date: 'Jun 15', count: 3200 },
  { date: 'Jun 17', count: 3500 },
  { date: 'Jun 19', count: 4100 },
  { date: 'Jun 21', count: 4500 },
];

export const faqData = [
  { id: '01', question: 'Where can I find the latest camp updates?', occurrences: 1204, trend: '+14%', resolution: 94 },
  { id: '02', question: "I'm new to Scouting. Where should I start?", occurrences: 987, trend: '+8%', resolution: 88 },
  { id: '03', question: 'How will I know if new events are added?', occurrences: 843, trend: '+22%', resolution: 91 },
  { id: '04', question: 'Will training reminders be posted here?', occurrences: 731, trend: '-3%', resolution: 97 },
  { id: '05', question: 'Who can I contact if I need more information?', occurrences: 698, trend: '+5%', resolution: 99 },
];

export const documentsData = [
  { docId: '1', name: 'Guide_to_Safe_Scouting.pdf', uploadDate: '2026-06-29', status: 'active', size: 2400000 },
  { docId: '2', name: 'Scoutmaster_Handbook.pdf', uploadDate: '2026-06-25', status: 'active', size: 1800000 },
  { docId: '3', name: 'Safety_Afloat.pdf', uploadDate: '2026-06-21', status: 'active', size: 950000 },
  { docId: '4', name: 'First_Aid.pdf', uploadDate: '2026-06-19', status: 'active', size: 1200000 },
];
