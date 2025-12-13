// Trading hours configuration for gold market
// Dubai/UAE timezone (GMT+4)

export function isTradingHours() {
  const now = new Date();
  
  // Convert to UAE time (GMT+4)
  const uaeTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  const hour = uaeTime.getHours();
  const day = uaeTime.getDay(); // 0 = Sunday, 6 = Saturday
  
  // Markets closed on weekends
  if (day === 0 || day === 6) {
    console.log(`⏸️  Weekend (${day === 6 ? 'Saturday' : 'Sunday'}) - markets closed`);
    return false;
  }
  
  // Trading hours: 11:00-15:00 and 17:00-21:00 UAE time (8 hours total, split sessions)
  // Morning session: London open + overlap (11:00-15:00)
  // Evening session: NY session + London close (17:00-21:00)
  const isMorningSession = hour >= 11 && hour < 15;
  const isEveningSession = hour >= 17 && hour < 21;
  const isTradingTime = isMorningSession || isEveningSession;
  
  if (!isTradingTime) {
    console.log(`⏸️  Outside trading hours (${hour}:00 UAE time). Skipping signal generation.`);
  }
  
  return isTradingTime;
}

export function getNextTradingTime() {
  const now = new Date();
  const uaeTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  const hour = uaeTime.getHours();
  const day = uaeTime.getDay();
  
  // If Saturday
  if (day === 6) {
    return 'Markets closed (weekend). Opens Monday 11:00 UAE';
  }
  
  // If Sunday
  if (day === 0) {
    return 'Markets closed (weekend). Opens Monday 11:00 UAE';
  }
  
  if (hour < 11) {
    return `${11 - hour} hours until morning session (11:00 UAE)`;
  } else if (hour >= 15 && hour < 17) {
    return `${17 - hour} hours until evening session (17:00 UAE)`;
  } else if (hour >= 21) {
    return `Markets closed. Opens tomorrow 11:00 UAE`;
  }
  
  return 'Currently in trading hours';
}
