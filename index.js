const {timeoutMicrosecondsToMclks} = require('./utils/calcs');
const {encodeTimeout, encodeVcselPeriod} = require('./utils/encode-decode');
const {BytesWritten} = require('i2c-bus')
const {I2CCore} = require('./I2C-core');
const {REG, tuning} = require('./utils/REG');


class VL53L0X extends I2CCore {
    constructor (address = REG.I2C_DEFAULT_ADDR, bus = 1) {
        super(address, bus)
    }

    async init (opts) {
        this.options = {...this.options, ...opts};
        await this.setupProviderModule();
        await this.setup(this.address);
        await this.optionsSetup(this.address);
    }

    async optionsSetup (pin) {
        if (this.options.signalRateLimit) {
            await this.setSignalRateLimit(this.options.signalRateLimit, pin)
        }

        if (this.options.vcselPulsePeriod && this.options.vcselPulsePeriod.pre) {
            await this.setVcselPulsePeriod('pre', this.options.vcselPulsePeriod.pre, pin)
        }

        if (this.options.vcselPulsePeriod && this.options.vcselPulsePeriod.final) {
            await this.setVcselPulsePeriod('final', this.options.vcselPulsePeriod.final, pin)
        }

        if (this.options.measurementTimingBudget) {
            await this.setMeasurementTimingBudget(this.options.measurementTimingBudget, pin)
        }

        if (this.options.distanceOffset) {
            await this.setDistanceOffset(this.options.distanceOffset, pin)
        }
    }

    async setup (pin) {
        await this.writeReg(REG.I2C_SLAVE_DEVICE_ADDRESS, this.address, REG.I2C_DEFAULT_ADDR);
        // "Set I2C standard mode"
        await this.writeReg(REG.I2C_STANDARD_MODE, REG.SYSRANGE_START, this.address);

        // disable SIGNAL_RATE_MSRC (bit 1) and SIGNAL_RATE_PRE_RANGE (bit 4) limit checks
        await this.writeReg(
            REG.MSRC_CONFIG_CONTROL,
            (await this.readReg(REG.MSRC_CONFIG_CONTROL, this.address)) | 0x12,
            this.address
        );
        // set final range signal rate limit to 0.25 MCPS (million counts per second)
        await this.setSignalRateLimit(0.25, pin)
        await this.writeReg(REG.SYSTEM_SEQUENCE_CONFIG, 0xff, this.address);
        await this.writeReg(0xff, REG.SYSTEM_SEQUENCE_CONFIG, this.address);
        await this.writeReg(REG.DYNAMIC_SPAD_REF_EN_START_OFFSET, REG.SYSRANGE_START, this.address);
        await this.writeReg(REG.DYNAMIC_SPAD_NUM_REQUESTED_REF_SPAD, 0x2c, this.address);
        await this.writeReg(0xff, REG.SYSRANGE_START, this.address);
        await this.writeReg(REG.GLOBAL_CONFIG_REF_EN_START_SELECT, 0xb4, this.address);

        const spadInfo = await this.getSpadInfo(pin);
        const spadMap = await this.readMulti(REG.GLOBAL_CONFIG_SPAD_ENABLES_REF_0, this.address, 6);
        const firstSpadToEnable = spadInfo.aperture ? 12 : 0; // 12 is the first aperture spad
        let spadsEnabled = 0;

        for (let i = 0; i < 48; i++) {
            if (i < firstSpadToEnable || spadsEnabled === spadInfo.count) {
                spadMap[1 + Math.floor(i / 8)] &= ~(1 << i % 8);
            } else if (((spadMap[1 + Math.floor(i / 8)] >> i % 8) & 0x1) > 0) {
                spadsEnabled++;
            }
        }

        await this.writeMulti(REG.GLOBAL_CONFIG_SPAD_ENABLES_REF_0, spadMap, this.address);

        // VL53L0X_load_tuning_settings()
        for (let i = 0; i < tuning.length; i++) {
            await this.writeReg(tuning[i], tuning[++i], this.address);
        }

        // -- VL53L0X_SetGpioConfig() begin
        await this.writeReg(
            REG.SYSTEM_INTERRUPT_CONFIG_GPIO,
            REG.SYSTEM_INTERMEASUREMENT_PERIOD,
            this.address
        );
        await this.writeReg(
            REG.GPIO_HV_MUX_ACTIVE_HIGH,
            (await this.readReg(REG.GPIO_HV_MUX_ACTIVE_HIGH, this.address)[0]) & ~0x10,
            this.address
        ); // active low

        await this.writeReg(REG.SYSTEM_INTERRUPT_CLEAR, REG.SYSTEM_SEQUENCE_CONFIG, this.address);

        this.timingBudget = await this.getMeasurementTimingBudgetInternal(pin);

        // "Disable MSRC and TCC by default"
        // MSRC = Minimum Signal Rate Check
        // TCC = Target CentreCheck
        await this.writeReg(REG.SYSTEM_SEQUENCE_CONFIG, 0xe8, this.address); //VL53L0X_SetSequenceStepEnable()
        // "Recalculate timing budget"
        await this.setMeasurementTimingBudget(this.timingBudget, pin);
        // VL53L0X_perform_vhv_calibration()
        await this.writeReg(REG.SYSTEM_SEQUENCE_CONFIG, REG.SYSTEM_SEQUENCE_CONFIG, this.address);
        await this.performSingleRefCalibrationInternal(0x40, pin);
        // VL53L0X_perform_phase_calibration()
        await this.writeReg(REG.SYSTEM_SEQUENCE_CONFIG, 0x02, this.address);
        await this.performSingleRefCalibrationInternal(REG.SYSRANGE_START, pin);

        // "restore the previous Sequence Config"
        await this.writeReg(REG.SYSTEM_SEQUENCE_CONFIG, 0xe8, this.address);
    }

    async setDistanceOffset (distanceOffset, pin) {
        await this.writeReg(REG.PRE_RANGE_CONFIG_SIGMA_THRESH_HI, distanceOffset, this.address, true);
    }

    async setMeasurementTimingBudget (budgetUs, pin) {
        if (budgetUs < 20000) {
            throw new Error('budget below MinTimingBudget');
        }

        if (pin) {
            // 1320 + 960  : start & end overhead values
            const budget = await this.getBudget(1320 + 960, pin);
            let usedBudgetUs = budget.value;

            if (budget.enables.finalRange) {
                usedBudgetUs += 550; // FinalRangeOverhead

                if (usedBudgetUs > budgetUs) {
                    throw new Error('Requested timeout too big.');
                }

                const finalRangeTimeoutUs = budgetUs - usedBudgetUs;
                // set_sequence_step_timeout()
                let finalRangeTimeoutMclks = timeoutMicrosecondsToMclks(
                    finalRangeTimeoutUs,
                    budget.timeouts.finalRangeVcselPeriodPclks
                );

                if (budget.enables.pre_range) {
                    finalRangeTimeoutMclks += budget.timeouts.preRangeMclks;
                }

                await this.writeReg(
                    REG.FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI,
                    encodeTimeout(finalRangeTimeoutMclks),
                    this.address,
                    true
                );

                this.timingBudget = budgetUs; // store for internal reuse
            }
        } else {
            for (const p of Object.keys(this.address)) {
                // 1320 + 960  : start & end overhead values
                const budget = await this.getBudget(1320 + 960, p);
                let usedBudgetUs = budget.value;

                if (budget.enables.finalRange) {
                    usedBudgetUs += 550;// FinalRangeOverhead

                    if (usedBudgetUs > budgetUs) {
                        throw new Error('Requested timeout too big.');
                    }

                    const finalRangeTimeoutUs = budgetUs - usedBudgetUs;
                    // set_sequence_step_timeout()
                    let finalRangeTimeoutMclks = timeoutMicrosecondsToMclks(
                        finalRangeTimeoutUs,
                        budget.timeouts.finalRangeVcselPeriodPclks
                    );

                    if (budget.enables.preRange) {
                        finalRangeTimeoutMclks += budget.timeouts.preRangeMclks;
                    }

                    await this.writeReg(
                        REG.FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI,
                        encodeTimeout(finalRangeTimeoutMclks),
                        this.address,
                        true
                    );

                    this.timingBudget = budgetUs; // store for internal reuse
                }
            }
        }
    }

    async getMeasurementTimingBudgetInternal (pin) {
        // 1920 + 960 : start & end overhead values
        const budget = await this.getBudget(1920 + 960, pin);

        if (budget.enables.finalRange) {
            return budget.value + budget.timeouts.finalRangeUs + 550; //FinalRangeOverhead
        }

        return budget.value;
    }

    async getMeasurementTimingBudget (pin) {
        if (pin) {
            return await this.getMeasurementTimingBudgetInternal(pin);
        } else {
            const toReturn = {};

            for (const p of Object.keys(this.address)) {
                toReturn[p] = await this.getMeasurementTimingBudgetInternal(p);
            }

            return toReturn;
        }
    }

    async setSignalRateLimit (limitMcps, pin) {
        // Q9.7 fixed point format (9 integer bits, 7 fractional bits)
        if (limitMcps < 0 || limitMcps > 511.99) {
            return;
        }

        if (pin) {
            return await this.writeReg(
                REG.FINAL_RANGE_CONFIG_MIN_COUNT_RATE_RTN_LIMIT,
                limitMcps * (1 << 7),
                this.address,
                true
            );
        } else {
            const toReturn = {};

            for (const p of Object.keys(this.address)) {
                toReturn[p] = await this.writeReg(
                    REG.FINAL_RANGE_CONFIG_MIN_COUNT_RATE_RTN_LIMIT,
                    limitMcps * (1 << 7),
                    this.address,
                    true
                );
            }

            return toReturn;
        }
    }

    async getSignalRateLimit (pin) {
        if (pin) {
            return (
                (await this.readReg(REG.FINAL_RANGE_CONFIG_MIN_COUNT_RATE_RTN_LIMIT, this.address, true)) /
                (1 << 7)
            );
        } else {
            const toReturn = {}

            for (const p of Object.keys(this.address)) {
                toReturn[p] =
                    (await this.readReg(REG.FINAL_RANGE_CONFIG_MIN_COUNT_RATE_RTN_LIMIT, this.address, true)) /
                    (1 << 7)
            }

            return toReturn
        }
    }

    async getRangeMillimeters () {
        await this.writeReg(REG.SYSRANGE_START, REG.SYSTEM_SEQUENCE_CONFIG, this.address);
        let range = await this.readReg(this.options.regAddressRead, this.address, true);
        await this.writeReg(REG.SYSTEM_INTERRUPT_CLEAR, REG.SYSTEM_SEQUENCE_CONFIG, this.address);

        return range;

    }

    async performSingleRefCalibrationInternal (vhvInitByte, pin) {
        await this.writeReg(REG.SYSRANGE_START, REG.SYSTEM_SEQUENCE_CONFIG | vhvInitByte, this.address) // VL53L0X_REG_SYSRANGE_MODE_START_STOP
        await this.writeReg(REG.SYSTEM_INTERRUPT_CLEAR, REG.SYSTEM_SEQUENCE_CONFIG, this.address)
        await this.writeReg(REG.SYSRANGE_START, REG.SYSRANGE_START, this.address)
    }

    async performSingleRefCalibration (vhvInitByte, pin) {
        if (pin) {
            await this.performSingleRefCalibrationInternal(vhvInitByte, pin)
        } else {
            for (const p of Object.keys(this.address)) {
                await this.performSingleRefCalibrationInternal(vhvInitByte, p)
            }
        }
    }

    async setVcselPulsePeriod (type, periodPclks, pin) {
        const register = {12: 0x18, 14: 0x30, 16: 0x40, 18: 0x50}
        const args = {
            8: [0x10, 0x02, 0x0c, 0x30],
            10: [0x28, 0x03, 0x09, 0x20],
            12: [0x38, 0x03, 0x08, 0x20],
            14: [0x48, 0x03, 0x07, 0x20],
        }

        if ((type !== 'pre' && type !== 'final') || (type !== 'final' && type !== 'pre')) {
            throw new Error('Invlaid type')
        }

        if (type === 'pre' && !register[periodPclks]) {
            throw new Error('invalid PRE period_pclks value')
        }

        if (type === 'final' && !args[periodPclks]) {
            throw new Error('invalid FINAL period_pclks value')
        }

        const vcselPeriodReg = encodeVcselPeriod(periodPclks)

        if (pin) {
            const sequence = await this.getSequenceSteps(pin)

            if (type === 'pre') {
                const newPreRangeTimeoutMclks = timeoutMicrosecondsToMclks(sequence.timeouts.preRangeUs, periodPclks) // set_sequence_step_timeout() - (SequenceStepId == VL53L0X_SEQUENCESTEP_PRE_RANGE)
                const newMsrcTimeoutMclks = timeoutMicrosecondsToMclks(sequence.timeouts.msrcDssTccUs, periodPclks) // set_sequence_step_timeout() - (SequenceStepId == VL53L0X_SEQUENCESTEP_MSRC)
                await this.writeReg(register[periodPclks], 0x18, this.address)
                await this.writeReg(REG.PRE_RANGE_CONFIG_VALID_PHASE_LOW, 0x08, this.address)
                await this.writeReg(REG.PRE_RANGE_CONFIG_VCSEL_PERIOD, vcselPeriodReg, this.address) // apply new VCSEL period
                await this.writeReg(
                    REG.PRE_RANGE_CONFIG_TIMEOUT_MACROP_HI,
                    encodeTimeout(newPreRangeTimeoutMclks),
                    this.address,
                    true
                )
                await await this.writeReg(
                    REG.MSRC_CONFIG_TIMEOUT_MACROP,
                    newMsrcTimeoutMclks > 256 ? 255 : newMsrcTimeoutMclks - 1,
                    this.address
                )
            }

            if (type === 'final') {
                const newPreRangeTimeoutMclks = timeoutMicrosecondsToMclks(sequence.timeouts.finalRangeUs, periodPclks)
                const preRange = sequence.enables.preRange ? sequence.timeouts.preRangeMclks : 0
                const newFinalRangeTimeoutMclks = newPreRangeTimeoutMclks + preRange // set_sequence_step_timeout() - (SequenceStepId == VL53L0X_SEQUENCESTEP_FINAL_RANGE)
                await this.writeReg(REG.FINAL_RANGE_CONFIG_VALID_PHASE_HIGH, args[periodPclks][0], this.address)
                await this.writeReg(REG.FINAL_RANGE_CONFIG_VALID_PHASE_LOW, 0x08, this.address)
                await this.writeReg(REG.GLOBAL_CONFIG_VCSEL_WIDTH, args[periodPclks][1], this.address)
                await this.writeReg(REG.ALGO_PHASECAL_CONFIG_TIMEOUT, args[periodPclks][2], this.address)
                await this.writeReg(0xff, 0x01, this.address)
                await this.writeReg(REG.ALGO_PHASECAL_LIM, args[periodPclks][3], this.address)
                await this.writeReg(0xff, 0x00, this.address)
                await this.writeReg(REG.FINAL_RANGE_CONFIG_VCSEL_PERIOD, vcselPeriodReg, this.address) // apply new VCSEL period
                await this.writeReg(
                    REG.FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI,
                    encodeTimeout(newFinalRangeTimeoutMclks),
                    this.address,
                    true
                )
            }

            await this.setMeasurementTimingBudget(this.timingBudget, pin)

            const sequenceConfig = await this.readReg(REG.SYSTEM_SEQUENCE_CONFIG, this.address) // VL53L0X_perform_phase_calibration()
            await this.writeReg(REG.SYSTEM_SEQUENCE_CONFIG, 0x02, this.address)
            await this.performSingleRefCalibrationInternal(REG.SYSRANGE_START, pin)
            await this.writeReg(REG.SYSTEM_SEQUENCE_CONFIG, sequenceConfig, this.address)
        } else {
            for (const p of Object.keys(this.address)) {
                const sequence = await this.getSequenceSteps(p)

                if (type === 'pre') {
                    const newPreRangeTimeoutMclks = timeoutMicrosecondsToMclks(sequence.timeouts.preRangeUs, periodPclks) // set_sequence_step_timeout() - (SequenceStepId == VL53L0X_SEQUENCESTEP_PRE_RANGE)
                    const newMsrcTimeoutMclks = timeoutMicrosecondsToMclks(sequence.timeouts.msrcDssTccUs, periodPclks) // set_sequence_step_timeout() - (SequenceStepId == VL53L0X_SEQUENCESTEP_MSRC)
                    await this.writeReg(register[periodPclks], 0x18, this.address)
                    await this.writeReg(REG.PRE_RANGE_CONFIG_VALID_PHASE_LOW, 0x08, this.address)
                    await this.writeReg(REG.PRE_RANGE_CONFIG_VCSEL_PERIOD, vcselPeriodReg, this.address) // apply new VCSEL period
                    await this.writeReg(
                        REG.PRE_RANGE_CONFIG_TIMEOUT_MACROP_HI,
                        encodeTimeout(newPreRangeTimeoutMclks),
                        this.address,
                        true
                    )
                    await await this.writeReg(
                        REG.MSRC_CONFIG_TIMEOUT_MACROP,
                        newMsrcTimeoutMclks > 256 ? 255 : newMsrcTimeoutMclks - 1,
                        this.address
                    )
                }

                if (type === 'final') {
                    const newPreRangeTimeoutMclks = timeoutMicrosecondsToMclks(sequence.timeouts.finalRangeUs, periodPclks)
                    const preRange = sequence.enables.preRange ? sequence.timeouts.preRangeMclks : 0
                    const newFinalRangeTimeoutMclks = newPreRangeTimeoutMclks + preRange // set_sequence_step_timeout() - (SequenceStepId == VL53L0X_SEQUENCESTEP_FINAL_RANGE)
                    await this.writeReg(REG.FINAL_RANGE_CONFIG_VALID_PHASE_HIGH, args[periodPclks][0], this.address)
                    await this.writeReg(REG.FINAL_RANGE_CONFIG_VALID_PHASE_LOW, 0x08, this.address)
                    await this.writeReg(REG.GLOBAL_CONFIG_VCSEL_WIDTH, args[periodPclks][1], this.address)
                    await this.writeReg(REG.ALGO_PHASECAL_CONFIG_TIMEOUT, args[periodPclks][2], this.address)
                    await this.writeReg(0xff, 0x01, this.address)
                    await this.writeReg(REG.ALGO_PHASECAL_LIM, args[periodPclks][3], this.address)
                    await this.writeReg(0xff, 0x00, this.address)
                    await this.writeReg(REG.FINAL_RANGE_CONFIG_VCSEL_PERIOD, vcselPeriodReg, this.address) // apply new VCSEL period
                    await this.writeReg(
                        REG.FINAL_RANGE_CONFIG_TIMEOUT_MACROP_HI,
                        encodeTimeout(newFinalRangeTimeoutMclks),
                        this.address,
                        true
                    )
                }

                await this.setMeasurementTimingBudget(this.timingBudget, p)

                const sequenceConfig = await this.readReg(REG.SYSTEM_SEQUENCE_CONFIG, this.address) // VL53L0X_perform_phase_calibration()
                await this.writeReg(REG.SYSTEM_SEQUENCE_CONFIG, 0x02, this.address)
                await this.performSingleRefCalibrationInternal(REG.SYSRANGE_START, p)
                await this.writeReg(REG.SYSTEM_SEQUENCE_CONFIG, sequenceConfig, this.address)
            }
        }
    }

    async getVcselPulsePeriod (type, pin) {
        if (pin) {
            return ((await this.readReg(type, this.address)) + 1) << 1
        } else {
            const toReturn = {}

            for (const p of Object.keys(this.address)) {
                toReturn[p] = ((await this.readReg(type, this.address)) + 1) << 1
            }

            return toReturn
        }
    }

    async resetPinsAddresses () {
        for (const pin of Object.keys(this.address)) {
            if (this.address[pin].gpio) {
                await this.gpioWrite(this.address[pin].gpio, 0)
            }
        }

        for (const pin of Object.keys(this.address)) {
            if (this.address[pin].gpio) {
                await this.gpioWrite(this.address[pin].gpio, 1)
            }
        }
    }

    get api () {
        return {
            measure: this.getRangeMillimeters.bind(this),
            resetPinsAddresses: this.resetPinsAddresses.bind(this),
            config: this.config,
            addresses: this.address,
            scanAddressesBeingUsed: this.scan.bind(this),
            setSignalRateLimit: this.setSignalRateLimit.bind(this),
            getSignalRateLimit: this.getSignalRateLimit.bind(this),
            getMeasurementTimingBudget: this.getMeasurementTimingBudget.bind(this),
            setMeasurementTimingBudget: this.setMeasurementTimingBudget.bind(this),
            setVcselPulsePeriod: this.setVcselPulsePeriod.bind(this),
            getVcselPulsePeriod: this.getVcselPulsePeriod.bind(this),
            performSingleRefCalibration: this.performSingleRefCalibration.bind(this),
            io: {
                write: this.write.bind(this),
                writeReg: this.writeReg.bind(this),
                writeMulti: this.writeMulti.bind(this),
                readReg: this.readReg.bind(this),
                readMulti: this.readMulti.bind(this),
            },
        }
    }

}

module.exports = VL53L0X;