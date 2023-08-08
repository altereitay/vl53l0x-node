const decodeTimeout = (value) => {
    return ((value & 0x00ff) << ((value & 0xff00) >> 8)) + 1 // format: "(LSByte * 2^MSByte) + 1"}
}
const encodeTimeout = (timeoutMclks) => {
    if (timeoutMclks <= 0) {
        return 0
    }
    // format: "(LSByte * 2^MSByte) + 1"
    let lsb = timeoutMclks - 1
    let msb = 0
    while ((lsb & 0xffffff00) > 0) {
        lsb >>= 1
        msb++
    }
    return (msb << 8) | (lsb & 0xff)
}

const encodeVcselPeriod = (periodPclks) => {
    return (periodPclks >> 1) - 1
}

module.exports = {decodeTimeout, encodeTimeout, encodeVcselPeriod};