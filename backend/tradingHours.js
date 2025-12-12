// Trading hours configuration for gold market
// Dubai timezone (GMT+4)

export function isTradingHours() {
  const now = new Date();
  
  // Convert to Dubai time (GMT+4)
  const dubaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  const hour = dubaiTime.getHours();
  
  // Trading hours: 13:00 - 21:00 Dubai time (8 hours)
  // This covers London close (13:00-17:00) and NY session (17:00-21:00)
  const isTradingTime = hour >= 13 && hour < 21;
  
  if (!isTradingTime) {
    console.log(`⏸️  Outside trading hours (${hour}:00 Dubai time). Skipping signal generation.`);
  }
  
  return isTradingTime;
}

export function getNextTradingTime() {
  const now = new Date();
  const dubaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  const hour = dubaiTime.getHours();
  
  if (hour < 13) {
    return `${13 - hour} hours until London close (13:00 Dubai)`;
  } else if (hour >= 21) {
    return `${24 - hour + 13} hours until London close (13:00 Dubai)`;
  }
  
  return 'Currently in trading hours';
}
