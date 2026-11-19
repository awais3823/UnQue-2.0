import {HttpError} from "../models/error.js"
import {Availability} from "../models/availability.js"
import { Appointment } from "../models/appointment.js";
import moment from "moment";
import mongoose from "mongoose";



// Controller to set availability
const setAvailability = async (req, res, next) => {
  try {
    console.log(req.user);  // Log req.user to see if it's coming through
    
    const { startTime, endTime } = req.body;
    
    if (!req.user || !req.user.id) {
      return next(new HttpError("No professor ID found", 400));
    }

    // Ensure startTime is before endTime
    if (new Date(startTime) >= new Date(endTime)) {
      return next(new HttpError("Start time must be before end time", 400));
    }

    // Check for overlapping availability
    const existingAvailability = await Availability.findOne({
      professorId: req.user.id,
      $or: [
        { startTime: { $lt: new Date(endTime) }, endTime: { $gt: new Date(startTime) } }, // Start overlaps
        { startTime: { $lt: new Date(startTime) }, endTime: { $gt: new Date(endTime) } }  // End overlaps
      ]
      // New time starts before an old one finishes
      // New time finishes after an old one start
    });

    if (existingAvailability) {
      return next(new HttpError("This time slot is already added for you professor", 400));
    }

    // Create new availability entry
    const availability = new Availability({
      professorId: req.user.id,  // Ensure that professorId is coming from req.user._id
      startTime,
      endTime,
    });

    await availability.save();

    const formattedStartTime = moment.utc(availability.startTime).format('MMMM Do YYYY, h:mm:ss a');
    const formattedEndTime = moment.utc(availability.endTime).format('MMMM Do YYYY, h:mm:ss a');

    res.status(201).json({
      message: "Availability added successfully",
      availability: {
        ...availability.toObject(),  // Spreading existing availability data
        startTime: formattedStartTime, // Replacing with formatted date
        endTime: formattedEndTime, // Replacing  with formatted date
      },
    });
  } catch (error) {
    console.log(error);  // Log error for better debugging
    return next(new HttpError("Adding availability failed", 500));
  }
};



  const cancelAppointments = async(req,res,next) => {
    try {
      const { studentId } = req.params;  // Student's ID from params
      const professorId = req.user.id;   // Professor's ID from the authenticated user
      console.log('Professor ID:', professorId);  // This should match the professor's ID in the appointment
      console.log('Student ID:', studentId);

      // Ensuring professor is authenticated and studentId is provided
      if (!studentId || !mongoose.Types.ObjectId.isValid(studentId)) {
        return next(new HttpError("Invalid or missing student ID", 400));
      }
  
      // Finding the  appointments between this professor and student
      const appointments = await Appointment.find({
        studentId: new mongoose.Types.ObjectId(studentId),
        professorId: new mongoose.Types.ObjectId(professorId),
        status: 'booked' // Only cancel booked appointments
      });
  
      if (!appointments || appointments.length === 0) {
        return next(new HttpError("No appointments found to cancel", 404));
      }
  
      // Updating the status of all appointments to "canceled"
      await Appointment.updateMany(
        {
          studentId: new mongoose.Types.ObjectId(studentId),
          professorId: new mongoose.Types.ObjectId(professorId),
          status: 'booked'
        },
        { status: 'cancelled' },  // must match the enum in models/appointment.js
        { runValidators: true }
      );

      res.status(200).json({
        message: `All appointments between professor ${professorId} and student ${studentId} have been cancelled.`
      });
  
    } catch (error) {
      console.error("Error cancelling appointments:", error);
      return next(new HttpError(error));
    }
  };
// Parse a client-supplied date strictly (ISO 8601). Returns a Date or null.
const parseIsoDate = (value) => {
  if (typeof value !== "string") return null;
  const parsed = moment(value, moment.ISO_8601, true);
  return parsed.isValid() ? parsed.toDate() : null;
};

// Update an existing free availability slot in place (same document, same _id).
// Only the professor who owns the slot may update it.
const updateAvailability = async (req, res, next) => {
  try {
    const { availabilityId } = req.params;
    const { startTime, endTime } = req.body;
    const professorId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(availabilityId)) {
      return next(new HttpError("Invalid availability ID format", 400));
    }
    if (startTime === undefined && endTime === undefined) {
      return next(new HttpError("Provide startTime and/or endTime to update", 400));
    }

    const availability = await Availability.findById(availabilityId);
    if (!availability) {
      return next(new HttpError("Availability slot not found", 404));
    }
    if (availability.professorId.toString() !== professorId) {
      return next(new HttpError("You can only update your own availability", 403));
    }

    // Validate dates; fields not sent keep their current value
    let newStart = availability.startTime;
    let newEnd = availability.endTime;
    if (startTime !== undefined) {
      newStart = parseIsoDate(startTime);
      if (!newStart) {
        return next(new HttpError("startTime must be a valid ISO 8601 date, e.g. 2026-12-01T09:00:00Z", 400));
      }
    }
    if (endTime !== undefined) {
      newEnd = parseIsoDate(endTime);
      if (!newEnd) {
        return next(new HttpError("endTime must be a valid ISO 8601 date, e.g. 2026-12-01T12:00:00Z", 400));
      }
    }
    if (newStart >= newEnd) {
      return next(new HttpError("Start time must be before end time", 400));
    }

    // The new window must not overlap another of this professor's slots
    const overlapping = await Availability.findOne({
      _id: { $ne: availability._id },
      professorId: availability.professorId,
      startTime: { $lt: newEnd },
      endTime: { $gt: newStart },
    });
    if (overlapping) {
      return next(new HttpError("The new time overlaps another of your availability slots", 409));
    }

    // Booked appointments inside the current window must stay covered,
    // either by the new window or by another of the professor's slots.
    const bookedInSlot = await Appointment.find({
      professorId: availability.professorId,
      status: "booked",
      time: { $gte: availability.startTime, $lte: availability.endTime },
    });
    if (bookedInSlot.length > 0) {
      const otherSlots = await Availability.find({
        _id: { $ne: availability._id },
        professorId: availability.professorId,
      });
      const isCovered = (t, start, end) => t >= start && t <= end;
      const orphaned = bookedInSlot.filter(
        (appt) =>
          !isCovered(appt.time, newStart, newEnd) &&
          !otherSlots.some((s) => isCovered(appt.time, s.startTime, s.endTime))
      );
      if (orphaned.length > 0) {
        return next(new HttpError(
          `Cannot update: ${orphaned.length} booked appointment(s) would fall outside the new time range`,
          409
        ));
      }
    }

    // Update the existing document in place; _id is unchanged
    availability.startTime = newStart;
    availability.endTime = newEnd;
    await availability.save();

    res.status(200).json({
      message: "Availability updated successfully",
      availability: {
        ...availability.toObject(),
        startTime: moment.utc(availability.startTime).format('MMMM Do YYYY, h:mm:ss a'),
        endTime: moment.utc(availability.endTime).format('MMMM Do YYYY, h:mm:ss a'),
      },
    });
  } catch (error) {
    console.error("Error updating availability:", error);
    return next(new HttpError("Updating availability failed", 500));
  }
};

export {setAvailability, cancelAppointments, updateAvailability};