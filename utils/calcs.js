export const calcMacroPeriod = (vcsel_period_pclks) => {
    return (2304 * vcsel_period_pclks * 1655 + 500) / 1000
}

export const timeoutMclksToMicroseconds = (timeout_period_mclks, vcsel_period_pclks) => {
    const macro_period_ns = calcMacroPeriod(vcsel_period_pclks)
    return Math.floor((timeout_period_mclks * macro_period_ns + macro_period_ns / 2) / 1000)
}

export const timeoutMicrosecondsToMclks = (timeout_period_us, vcsel_period_pclks) => {
    const macro_period_ns = calcMacroPeriod(vcsel_period_pclks)
    return (timeout_period_us * 1000 + macro_period_ns / 2) / macro_period_ns
}