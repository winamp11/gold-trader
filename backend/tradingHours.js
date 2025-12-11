// Trading hours configuration for gold market
// Dubai timezone (GMT+4)

export function isTradingHours() {
  const now = new Date();
  
  // Convert to Dubai time (GMT+4)
  const dubaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  const hour = dubaiTime.getHours();
  
  // Trading hours: 12:00 - 22:00 Dubai time
  // This covers London (12:00-20:00) and NY (17:00-02:00 next day)
  const isTradingTime = hour >= 12 && hour < 22;
  
  if (!isTradingTime) {
    console.log(`⏸️  Outside trading hours (${hour}:00 Dubai time). Skipping signal generation.`);
  }
  
  return isTradingTime;
}

export function getNextTradingTime() {
  const now = new Date();
  const dubaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  const hour = dubaiTime.getHours();
  
  if (hour < 12) {
    return `${12 - hour} hours until London open (12:00 Dubai)`;
  } else if (hour >= 22) {
    return `${24 - hour + 12} hours until London open (12:00 Dubai)`;
  }
  
  return 'Currently in trading hours';
}
