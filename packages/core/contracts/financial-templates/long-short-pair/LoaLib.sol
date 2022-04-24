// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.0;

library LoaLib {
    struct Sponsor {
        string name; // sponsor name
        address delegate; // entity delegated to
    }

    struct School {
        string name; // school name
        address delegate; // entity delegated to
        Syllabus syllabus; // school syllabus
        address sponsor; // address of sponsor
        bool agreed; // has agreed to sponsor promise
        uint256 score; // school score
    }

    struct Syllabus {
        string[] questions; // questions to assess learners
        string[] answers; // answers to assessment
    }

    struct Learner {
        string name; // learner name
        address school; // address of school
        address learner; // address of learner
        uint256 score; // learner score
    }
}
