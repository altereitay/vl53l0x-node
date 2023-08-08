const calcMacroPeriod = (vcselPeriodPclks) => {
    return (2304 * vcselPeriodPclks * 1655 + 500) / 1000;
}

const timeoutMclksToMicroseconds = (timeoutPeriodMclks, vcselPeriodPclks) => {
    const macroPeriodNs = calcMacroPeriod(vcselPeriodPclks);
    return Math.floor((timeoutPeriodMclks * macroPeriodNs + macroPeriodNs / 2) / 1000);
}

const timeoutMicrosecondsToMclks = (timeoutPeriodUs, vcselPeriodPclks) => {
    const macroPeriodNs = calcMacroPeriod(vcselPeriodPclks);
    return (timeoutPeriodUs * 1000 + macroPeriodNs / 2) / macroPeriodNs;
}

module.exports = {calcMacroPeriod, timeoutMclksToMicroseconds, timeoutMicrosecondsToMclks};