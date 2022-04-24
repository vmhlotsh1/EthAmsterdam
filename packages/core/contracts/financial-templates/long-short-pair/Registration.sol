// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.0;
import "./LoaLib.sol";

contract Registration {
    LoaLib.School public school;
    uint256 public balance;
    uint256 public registrationStake; // learner registration stake in wei for this contract

    mapping(address => LoaLib.Learner) public learners;

    constructor(string memory schoolName, uint256 learnerStake) {
        require(bytes(schoolName).length > 0, "School must have a name");
        require(learnerStake > 0, "A learner stake of more than 0 wei must be specified");

        string[] memory questions;
        string[] memory answers;

        school = LoaLib.School({
            name: schoolName,
            delegate: msg.sender,
            syllabus: LoaLib.Syllabus({ questions: questions, answers: answers }),
            sponsor: address(0x0),
            score: 0
        });
    }

    function setSchoolSyllabus(string[] memory questions, string[] memory answers) public {
        require(school.delegate != address(0x0), "A school must exist before a syllabus can be created.");
        require(questions.length == answers.length, "Every question must have an answer.");

        school.syllabus = LoaLib.Syllabus({ questions: questions, answers: answers });
    }

    function addLearner(string memory name) public payable {
        require(msg.sender != school.delegate, "The school may not also be a learner.");
        require(bytes(name).length > 0, "The learner must have a name.");
        require(learners[msg.sender].learner == address(0x0), "A learner can not be added more than once.");
        require(
            msg.value >= registrationStake,
            string(abi.encodePacked("A learner must stake at least ", registrationStake, "wei."))
        );

        balance += msg.value;

        learners[msg.sender] = LoaLib.Learner({ name: name, school: school.delegate, learner: msg.sender, score: 0 });
    }
}
