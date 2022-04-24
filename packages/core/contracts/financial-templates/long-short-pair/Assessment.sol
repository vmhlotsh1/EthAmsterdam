// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.0;

import "./LoaLib.sol";

contract Assessment {
    LoaLib.Sponsor sponsor;
    LoaLib.School school;

    constructor(LoaLib.School memory school) {
        require(bytes(school.name).length > 0, "School must have a name.");
        require(school.delegate != address(0x0), "School must have an address.");
        require(school.syllabus.questions.length > 0, "School must have a syllabus.");
        require(
            school.syllabus.questions.length == school.syllabus.answers.length,
            "School syllabus must be complete."
        );
    }
}
