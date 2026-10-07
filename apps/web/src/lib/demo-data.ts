// Demo/Mock Data for Development

export const DEMO_MODE = true;

export const demoClinic = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Klinik Merkezi',
  phone: '+90 (555) 100-0001',
  email: 'info@klinikmerkezi.com.tr',
  address: 'Taksim, İstanbul',
  city: 'İstanbul',
  country: 'Türkiye',
};

export const demoDoctors = [
  {
    id: '33333333-3333-3333-3333-333333333333',
    name: 'Dr. Ece Kara',
    specialization: 'Genel Diş Tedavisi',
    phone: '+90 (555) 111-1111',
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    name: 'Dr. Cem Aydemir',
    specialization: 'Ortodontisi',
    phone: '+90 (555) 222-2222',
  },
];

export const demoPatients = [
  {
    id: '55555555-5555-5555-5555-555555555555',
    name: 'Ahmet Yılmaz',
    phone: '+90 (555) 123-4567',
    email: 'ahmet@example.com',
    birthDate: '1985-03-15',
    gender: 'M',
    identityNumber: '12345678901',
  },
  {
    id: '66666666-6666-6666-6666-666666666666',
    name: 'Mehmet Şahin',
    phone: '+90 (555) 234-5678',
    email: 'mehmet@example.com',
    birthDate: '1990-07-22',
    gender: 'M',
    identityNumber: '23456789012',
  },
  {
    id: '77777777-7777-7777-7777-777777777777',
    name: 'Selin Özkan',
    phone: '+90 (555) 345-6789',
    email: 'selin@example.com',
    birthDate: '1988-11-30',
    gender: 'F',
    identityNumber: '34567890123',
  },
];

export const demoAppointments = [
  {
    id: '88888888-8888-8888-8888-888888888888',
    patientId: '55555555-5555-5555-5555-555555555555',
    patientName: 'Ahmet Yılmaz',
    doctorId: '33333333-3333-3333-3333-333333333333',
    doctorName: 'Dr. Ece Kara',
    date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
    time: '09:30',
    status: 'scheduled',
    chair: 2,
  },
  {
    id: '99999999-9999-9999-9999-999999999999',
    patientId: '66666666-6666-6666-6666-666666666666',
    patientName: 'Mehmet Şahin',
    doctorId: '44444444-4444-4444-4444-444444444444',
    doctorName: 'Dr. Cem Aydemir',
    date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
    time: '11:00',
    status: 'scheduled',
    chair: 3,
  },
];

export const demoTreatmentPlans = [
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    patientId: '55555555-5555-5555-5555-555555555555',
    patientName: 'Ahmet Yılmaz',
    doctorId: '33333333-3333-3333-3333-333333333333',
    doctorName: 'Dr. Ece Kara',
    title: 'Bütün Diş İmplantı',
    totalAmount: 8500,
    paidAmount: 2500,
    status: 'in_progress',
  },
];

export const demoLeads = [
  {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    name: 'Murat Çetin',
    phone: '+90 (555) 123-4567',
    email: 'murat@example.com',
    status: 'new',
    source: 'social_media',
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    name: 'Gülcan Kara',
    phone: '+90 (555) 234-5678',
    email: 'gulcan@example.com',
    status: 'contacted',
    source: 'online',
    createdAt: new Date(Date.now() - 172800000).toISOString(),
  },
];

export const demoInventory = [
  {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    code: 'MAT-001',
    name: 'Composite Reçine (A2)',
    category: 'materials',
    quantity: 2,
    minimum: 5,
    price: 850,
    supplier: 'Dental Plus',
  },
  {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    code: 'ALT-002',
    name: 'Yüksek Hızlı Bur Motoru',
    category: 'instruments',
    quantity: 8,
    minimum: 3,
    price: 2500,
    supplier: 'Dental Tech',
  },
];

export const demoLabOrders = [
  {
    id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    orderNumber: 'LAB-2024-001',
    patientName: 'Ahmet Yılmaz',
    doctorName: 'Dr. Ece Kara',
    type: 'crown',
    material: 'ceramic',
    toothNumber: '16',
    dueDate: new Date(Date.now() + 259200000).toISOString().split('T')[0],
    status: 'in_progress',
  },
];

export const demoReminders = [
  {
    id: '10101010-1010-1010-1010-101010101010',
    patientName: 'Ahmet Yılmaz',
    doctorName: 'Dr. Ece Kara',
    appointmentTime: '07 Ekim 09:30',
    reminderType: 'sms',
    sendTime: '06 Ekim 09:30',
    status: 'sent',
  },
];
