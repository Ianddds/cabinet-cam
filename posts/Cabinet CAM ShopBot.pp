+================================================================
+ Cabinet CAM - ShopBot (inch)
+ A Vectric-format post. Edit it here, or copy it under a new name
+ (and change POST_NAME) for another machine.
+
+ Laid out like ShopBot's own PartWorks post: units check, CN 90,
+ &Tool + C9 for a bit change (change the bit and zero Z), CG arcs,
+ CN 91 if the software is in metric. Speeds are inches per SECOND
+ (the 0.0166667 multiplier). No JS: jog speed is a machine setting.
+
+ The first bit is already in the machine: the HEADER has no C9.
+ Cabinet CAM extras (Vectric won't load this file back):
+   begin OPERATOR_STOP  - screw hold-downs: stop for the operator
+   [MESSAGE]            - the stop's message
+   [SPINUP]             - spin-up seconds (Cutting settings)
+================================================================
POST_NAME = "ShopBot - Cabinet CAM (inch)(*.sbp)"
FILE_EXTENSION = "sbp"
UNITS = "INCHES"

VAR SPINDLE_SPEED = [S|A||1.0]
VAR CUT_RATE = [FC|A||1.4|0.0166667]
VAR PLUNGE_RATE = [FP|A||1.4|0.0166667]
VAR X_POSITION = [X|A||1.4]
VAR Y_POSITION = [Y|A||1.4]
VAR Z_POSITION = [Z|A||1.4]
VAR ARC_CENTRE_I_INC_POSITION = [I|A||1.4]
VAR ARC_CENTRE_J_INC_POSITION = [J|A||1.4]
VAR SAFE_Z_HEIGHT = [SAFEZ|A||1.4]
VAR X_HOME_POSITION = [XH|A||1.4]
VAR Y_HOME_POSITION = [YH|A||1.4]
VAR Z_LENGTH = [ZLENGTH|A||1.4]

begin HEADER
"'[FILENAME]"
"'SHOPBOT ROUTER FILE IN INCHES - Cabinet CAM"
"'Material [MATERIAL] [ZLENGTH]in"
"'Z zero = [Z_ORIGIN]"
"'Safe Z = [SAFEZ]"
"'UNITS:Inches"
"IF %(25)=1 THEN GOTO UNIT_ERROR	'check to see software is set to standard"
"SA"
"CN, 90"
"'Bit: [TOOLNAME] - already loaded"
"&Tool = [T]"
"JZ,[SAFEZ]"
"C6"
"PAUSE [SPINUP]"

begin NEW_SEGMENT
"'[TOOLPATH_NAME]"
"MS,[FC],[FP]"

begin TOOLCHANGE
"C7"
"JZ,[SAFEZ]"
"&Tool = [T]	'[TOOLNAME]"
"C9	'Change tool (and zero Z)"
"C6"
"PAUSE [SPINUP]"

begin OPERATOR_STOP
"C7"
"JZ,[SAFEZ]"
"'[MESSAGE]"
"PAUSE"
"C6"
"PAUSE [SPINUP]"

begin RAPID_MOVE
"J3,[X],[Y],[Z]"

begin FEED_MOVE
"M3,[X],[Y],[Z]"

begin PLUNGE_MOVE
"MZ,[Z]"

begin CW_ARC_MOVE
"CG, ,[X],[Y],[I],[J],T,1"

begin CCW_ARC_MOVE
"CG, ,[X],[Y],[I],[J],T,-1"

begin FOOTER
"JZ,[SAFEZ]"
"J2,[XH],[YH]"
"'Turning router OFF"
"C7"
"END"
"'"
"UNIT_ERROR:"
"CN, 91	'Run file explaining unit error"
"END"
