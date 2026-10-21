// Contact fields every newly created Node must carry (contactPhone and
// structured openingHours are required on POST /nodes and Node onboarding).
// Spread into a Node payload: { ...baseFields, ...NODE_CONTACT_FIELDS }.
export const NODE_CONTACT_FIELDS = {
  contactPhone: '+2348031234567',
  openingHours: {
    mon: [{ open: '08:00', close: '18:00' }],
    tue: [{ open: '08:00', close: '18:00' }],
    wed: [{ open: '08:00', close: '18:00' }],
    thu: [{ open: '08:00', close: '18:00' }],
    fri: [{ open: '08:00', close: '18:00' }],
    sat: [{ open: '09:00', close: '14:00' }],
  },
};
