const decodeTimeout = (value) => {
    return ((value & 0x00ff) << ((value & 0xff00) >> 8)) + 1 // format: "(LSByte * 2^MSByte) + 1"}
}
export const encodeTimeout = (timeout_mclks) => {
    if (timeout_mclks <= 0) {
        return 0
    }
    // format: "(LSByte * 2^MSByte) + 1"
    let lsb = timeout_mclks - 1
    let msb = 0
    while ((lsb & 0xffffff00) > 0) {
        lsb >>= 1
        msb++
    }
    return (msb << 8) | (lsb & 0xff)
}

export const encodeVcselPeriod = (period_pclks) => {
    return (period_pclks >> 1) - 1
}

module.exports = {decodeTimeout};